export const resolutionRewardsAbi = [
    {
        type: "function",
        name: "submitProposal",
        stateMutability: "nonpayable",
        inputs: [
            { name: "marketId", type: "bytes32" },
            { name: "side", type: "uint8" },
        ],
        outputs: [{ name: "proposalId", type: "uint256" }],
    },
    {
        type: "function",
        name: "requestWithdrawal",
        stateMutability: "nonpayable",
        inputs: [{ name: "proposalId", type: "uint256" }],
        outputs: [],
    },
    {
        type: "function",
        name: "releaseExpiredProposal",
        stateMutability: "nonpayable",
        inputs: [{ name: "proposalId", type: "uint256" }],
        outputs: [],
    },
    {
        type: "function",
        name: "syncFinalization",
        stateMutability: "nonpayable",
        inputs: [{ name: "marketId", type: "bytes32" }],
        outputs: [],
    },
    {
        type: "function",
        name: "claim",
        stateMutability: "nonpayable",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ name: "amount", type: "uint256" }],
    },
] as const;
