import { encodeFunctionData, type Address, type Hex } from "viem";
import { erc20Abi, resolutionRewardsAbi } from "../abis";
import type { DepositWalletCall } from "../types";

export type ResolutionRewardSide = "NO" | "YES";

export function buildResolutionRewardProposalCalls(args: {
    usdc: Address;
    rewards: Address;
    marketId: Hex;
    side: ResolutionRewardSide;
    bond: bigint;
}): DepositWalletCall[] {
    if (args.bond <= 0n) throw new Error("bond must be positive");
    return [
        call(args.usdc, encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [args.rewards, args.bond],
        })),
        call(args.rewards, encodeFunctionData({
            abi: resolutionRewardsAbi,
            functionName: "submitProposal",
            args: [args.marketId, args.side === "NO" ? 1 : 2],
        })),
    ];
}

export function buildResolutionRewardWithdrawalCall(rewards: Address, proposalId: bigint): DepositWalletCall {
    return rewardsCall(rewards, "requestWithdrawal", [proposalId]);
}

export function buildResolutionRewardReleaseCall(rewards: Address, proposalId: bigint): DepositWalletCall {
    return rewardsCall(rewards, "releaseExpiredProposal", [proposalId]);
}

export function buildResolutionRewardSyncCall(rewards: Address, marketId: Hex): DepositWalletCall {
    return rewardsCall(rewards, "syncFinalization", [marketId]);
}

export function buildResolutionRewardClaimCall(rewards: Address, token: Address): DepositWalletCall {
    return rewardsCall(rewards, "claim", [token]);
}

function rewardsCall(
    rewards: Address,
    functionName: "requestWithdrawal" | "releaseExpiredProposal" | "syncFinalization" | "claim",
    args: readonly [bigint] | readonly [Hex] | readonly [Address],
): DepositWalletCall {
    return call(rewards, encodeFunctionData({ abi: resolutionRewardsAbi, functionName, args } as never));
}

function call(target: Address, data: Hex): DepositWalletCall {
    return { target, value: "0", data };
}
