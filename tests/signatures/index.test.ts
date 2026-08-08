import { expect } from "chai";
import { Wallet } from "ethers";

import { RelayClient } from "../../src/client";
import {
    buildDepositWalletBatchRequest,
    buildDepositWalletCreateRequest,
    buildResolutionRewardClaimCall,
    buildResolutionRewardProposalCalls,
    deriveDepositWallet,
} from "../../src/builder";
import { decodeFunctionData } from "viem";
import { resolutionRewardsAbi } from "../../src/abis";
import { getContractConfig } from "../../src/config";
import { BUILDER_CREDS_UNAVAILABLE } from "../../src/errors";
import { createAbstractSigner } from "../../src/signer";
import { TransactionType } from "../../src/types";

describe("deposit wallet relayer requests", () => {
    const chainId = 80002;
    const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const wallet = new Wallet(privateKey);
    const config = getContractConfig(chainId).DepositWalletContracts;
    const legacyPattern = new RegExp(
        ["SA" + "FE", "PRO" + "XY", "relay" + "-payload"].join("|"),
        "i",
    );

    it("builds wallet-create requests only", () => {
        const request = buildDepositWalletCreateRequest(owner, config);

        expect(request.type).equal(TransactionType.WALLET_CREATE);
        expect(request.from).equal(owner);
        expect(request.to).equal(config.DepositWalletFactory);
        expect(JSON.stringify(request)).not.match(legacyPattern);
    });

    it("derives deposit wallet addresses from current config", () => {
        const address = deriveDepositWallet(
            owner,
            config.DepositWalletFactory,
            config.DepositWalletBeacon,
        );

        expect(address).match(/^0x[0-9a-fA-F]{40}$/);
        expect(address).equal("0xF3ab66D34F0B14C9a4f8564Ec8baaBBf51ad0Fd6");
    });

    it("signs wallet batch requests", async () => {
        const signer = createAbstractSigner(chainId, wallet);
        const walletAddress = deriveDepositWallet(
            owner,
            config.DepositWalletFactory,
            config.DepositWalletBeacon,
        );
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

    it("rejects authenticated relayer submissions without builder credentials", async () => {
        const client = new RelayClient("https://relayer.example", chainId, wallet);

        try {
            await client.deployDepositWallet();
            throw new Error("expected deployDepositWallet to reject");
        } catch (err) {
            expect((err as Error).message).equal(BUILDER_CREDS_UNAVAILABLE.message);
        }

        try {
            await client.getTransactions();
            throw new Error("expected getTransactions to reject");
        } catch (err) {
            expect((err as Error).message).equal(BUILDER_CREDS_UNAVAILABLE.message);
        }
    });

    it("builds atomic Resolution Rewards proposal calls and a fixed-beneficiary claim", () => {
        const rewards = "0x1111111111111111111111111111111111111111";
        const usdc = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";
        const marketId = `0x${"12".repeat(32)}` as `0x${string}`;
        const calls = buildResolutionRewardProposalCalls({ usdc, rewards, marketId, side: "YES", bond: 300_000_000n });

        expect(calls).to.have.length(2);
        expect(calls[0].target).equal(usdc);
        expect(calls[1].target).equal(rewards);
        expect(decodeFunctionData({ abi: resolutionRewardsAbi, data: calls[1].data }).functionName).equal("submitProposal");

        const claim = buildResolutionRewardClaimCall(rewards, usdc);
        const decodedClaim = decodeFunctionData({ abi: resolutionRewardsAbi, data: claim.data });
        expect(decodedClaim.functionName).equal("claim");
        expect(decodedClaim.args).deep.equal([usdc]);
    });
});
