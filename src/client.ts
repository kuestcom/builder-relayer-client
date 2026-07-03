import { JsonRpcSigner, Wallet } from "ethers";
import { WalletClient } from "viem";
import { BuilderConfig, BuilderHeaderPayload } from "@kuestcom/builder-signing-sdk";
import { createAbstractSigner, IAbstractSigner } from "./signer";
import { GET, POST, HttpClient, RequestOptions } from "./http-helpers";
import {
    DepositWalletCall,
    DepositWalletTransactionArgs,
    GetDeployedResponse,
    NoncePayload,
    RelayerTransaction,
    RelayerTransactionResponse,
    TransactionType,
} from "./types";
import {
    GET_DEPLOYED,
    GET_NONCE,
    GET_TRANSACTION,
    GET_TRANSACTIONS,
    SUBMIT_TRANSACTION,
} from "./endpoints";
import {
    buildDepositWalletBatchRequest,
    buildDepositWalletCreateRequest,
    deriveDepositWallet,
} from "./builder";
import { sleep } from "./utils";
import { ClientRelayerTransactionResponse } from "./response";
import { ContractConfig, getContractConfig, isDepositWalletContractConfigValid } from "./config";
import {
    BUILDER_CREDS_UNAVAILABLE,
    CONFIG_UNSUPPORTED_ON_CHAIN,
    SIGNER_UNAVAILABLE,
} from "./errors";

export class RelayClient {
    readonly relayerUrl: string;
    readonly chainId: number;
    readonly contractConfig: ContractConfig;
    readonly httpClient: HttpClient;
    readonly signer?: IAbstractSigner;
    readonly builderConfig?: BuilderConfig;

    constructor(
        relayerUrl: string,
        chainId: number,
        signer?: Wallet | JsonRpcSigner | WalletClient,
        builderConfig?: BuilderConfig,
    ) {
        this.relayerUrl = relayerUrl.endsWith("/") ? relayerUrl.slice(0, -1) : relayerUrl;
        this.chainId = chainId;
        this.contractConfig = getContractConfig(chainId);
        this.httpClient = new HttpClient();

        if (signer !== undefined) {
            this.signer = createAbstractSigner(chainId, signer);
        }
        if (builderConfig !== undefined) {
            this.builderConfig = builderConfig;
        }
    }

    public async getNonce(
        signerAddress: string,
        signerType = TransactionType.WALLET,
    ): Promise<NoncePayload> {
        return this.send(GET_NONCE, GET, { params: { address: signerAddress, type: signerType } });
    }

    public async getTransaction(transactionId: string): Promise<RelayerTransaction[]> {
        return this.send(GET_TRANSACTION, GET, { params: { id: transactionId } });
    }

    public async getTransactions(): Promise<RelayerTransaction[]> {
        this.builderCredsNeeded();
        return this.sendAuthedRequest(GET, GET_TRANSACTIONS);
    }

    public async getDeployed(address: string): Promise<boolean> {
        const resp = (await this.send(GET_DEPLOYED, GET, {
            params: { address },
        })) as GetDeployedResponse;
        return resp.deployed;
    }

    public async deployDepositWallet(): Promise<RelayerTransactionResponse> {
        this.signerNeeded();
        this.builderCredsNeeded();
        const from = await this.signer!.getAddress();
        const depositWalletConfig = this.contractConfig.DepositWalletContracts;
        if (!isDepositWalletContractConfigValid(depositWalletConfig)) {
            throw CONFIG_UNSUPPORTED_ON_CHAIN;
        }

        const request = buildDepositWalletCreateRequest(from, depositWalletConfig);
        const resp = await this.sendAuthedRequest(
            POST,
            SUBMIT_TRANSACTION,
            JSON.stringify(request),
        );
        return new ClientRelayerTransactionResponse(
            resp.transactionID,
            resp.state,
            resp.transactionHash,
            this,
        );
    }

    public async executeDepositWalletBatch(
        calls: DepositWalletCall[],
        walletAddress: string,
        deadline: string,
    ): Promise<RelayerTransactionResponse> {
        this.signerNeeded();
        this.builderCredsNeeded();
        if (calls.length === 0) {
            throw new Error("no deposit wallet calls to execute");
        }

        const from = await this.signer!.getAddress();
        const depositWalletConfig = this.contractConfig.DepositWalletContracts;
        if (!isDepositWalletContractConfigValid(depositWalletConfig)) {
            throw CONFIG_UNSUPPORTED_ON_CHAIN;
        }

        const noncePayload = await this.getNonce(from, TransactionType.WALLET);
        const args: DepositWalletTransactionArgs = {
            from,
            chainId: this.chainId,
            walletAddress,
            nonce: noncePayload.nonce,
            deadline,
            calls,
        };

        const request = await buildDepositWalletBatchRequest(
            this.signer!,
            args,
            depositWalletConfig,
        );

        const resp = await this.sendAuthedRequest(
            POST,
            SUBMIT_TRANSACTION,
            JSON.stringify(request),
        );
        return new ClientRelayerTransactionResponse(
            resp.transactionID,
            resp.state,
            resp.transactionHash,
            this,
        );
    }

    public async deriveDepositWallet(): Promise<string> {
        this.signerNeeded();
        const config = this.contractConfig.DepositWalletContracts;
        if (!isDepositWalletContractConfigValid(config)) {
            throw CONFIG_UNSUPPORTED_ON_CHAIN;
        }
        const address = await this.signer!.getAddress();
        return deriveDepositWallet(
            address,
            config.DepositWalletFactory,
            config.DepositWalletBeacon,
        );
    }

    public async deriveDepositWalletAddress(): Promise<string> {
        return this.deriveDepositWallet();
    }

    public async pollUntilState(
        transactionId: string,
        states: string[],
        failState?: string,
        maxPolls = 10,
        pollFrequency = 2000,
    ): Promise<RelayerTransaction | undefined> {
        const pollFreq = pollFrequency >= 1000 ? pollFrequency : 2000;
        for (let pollCount = 0; pollCount < maxPolls; pollCount++) {
            const txns = await this.getTransaction(transactionId);
            if (txns.length > 0) {
                const txn = txns[0];
                if (states.includes(txn.state)) {
                    return txn;
                }
                if (failState !== undefined && txn.state === failState) {
                    return undefined;
                }
            }
            await sleep(pollFreq);
        }
        return undefined;
    }

    private async sendAuthedRequest(method: string, path: string, body?: string): Promise<any> {
        if (this.canBuilderAuth()) {
            const builderHeaders = await this._generateBuilderHeaders(method, path, body);
            if (builderHeaders !== undefined) {
                return this.send(path, method, { headers: { ...builderHeaders }, data: body });
            }
        }

        throw BUILDER_CREDS_UNAVAILABLE;
    }

    private async _generateBuilderHeaders(
        method: string,
        path: string,
        body?: string,
    ): Promise<BuilderHeaderPayload | undefined> {
        if (this.builderConfig === undefined) {
            return undefined;
        }
        return this.builderConfig.generateBuilderHeaders(method, path, body);
    }

    private canBuilderAuth(): boolean {
        return this.builderConfig !== undefined && this.builderConfig.isValid();
    }

    private async send(endpoint: string, method: string, options?: RequestOptions): Promise<any> {
        const resp = await this.httpClient.send(`${this.relayerUrl}${endpoint}`, method, options);
        return resp.data;
    }

    private signerNeeded(): void {
        if (this.signer === undefined) {
            throw SIGNER_UNAVAILABLE;
        }
    }

    private builderCredsNeeded(): void {
        if (!this.canBuilderAuth()) {
            throw BUILDER_CREDS_UNAVAILABLE;
        }
    }
}
