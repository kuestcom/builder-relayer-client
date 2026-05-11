import { expect } from "chai";
import { Wallet } from "ethers";

import { buildDepositWalletBatchRequest, buildDepositWalletCreateRequest, deriveDepositWallet } from "../../src/builder";
import { getContractConfig } from "../../src/config";
import { createAbstractSigner } from "../../src/signer";
import { TransactionType } from "../../src/types";

describe("deposit wallet relayer requests", () => {
    const chainId = 80002;
    const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const wallet = new Wallet(privateKey);
    const config = getContractConfig(chainId).DepositWalletContracts;
    const legacyPattern = new RegExp(["SA" + "FE", "PRO" + "XY", "relay" + "-payload"].join("|"), "i");

    it("builds wallet-create requests only", () => {
        const request = buildDepositWalletCreateRequest(owner, config);

        expect(request.type).equal(TransactionType.WALLET_CREATE);
        expect(request.from).equal(owner);
        expect(request.to).equal(config.DepositWalletFactory);
        expect(JSON.stringify(request)).not.match(legacyPattern);
    });

    it("derives deposit wallet addresses from current config", () => {
        const address = deriveDepositWallet(owner, config.DepositWalletFactory, config.DepositWalletImplementation);

        expect(address).match(/^0x[0-9a-fA-F]{40}$/);
        expect(address).equal("0x053258Cfb6124a089363F89dA04b2eFa39b34e2d");
    });

    it("signs wallet batch requests", async () => {
        const signer = createAbstractSigner(chainId, wallet);
        const walletAddress = deriveDepositWallet(owner, config.DepositWalletFactory, config.DepositWalletImplementation);
        const request = await buildDepositWalletBatchRequest(
            signer,
            {
                from: owner,
                chainId,
                walletAddress,
                nonce: "0",
                deadline: "9999999999",
                calls: [
                    {
                        target: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
                        value: "0",
                        data: "0x",
                    },
                ],
            },
            config,
        );

        expect(request.type).equal(TransactionType.WALLET);
        expect(request.from).equal(owner);
        expect(request.to).equal(config.DepositWalletFactory);
        expect(request.depositWalletParams.depositWallet).equal(walletAddress);
        expect(request.signature).match(/^0x[0-9a-fA-F]+$/);
        expect(JSON.stringify(request)).not.match(legacyPattern);
    });
});
