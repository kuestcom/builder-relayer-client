import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { RelayClient, DepositWalletCall } from "../src";
import { BuilderApiKeyCreds, BuilderConfig } from "@kuestcom/builder-signing-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, encodeFunctionData, Hex, http, maxUint256, prepareEncodeFunctionData } from "viem";
import { polygon } from "viem/chains";

dotenvConfig({ path: resolve(__dirname, "../.env") });

const erc20Abi = [
    {
        "constant": false,"inputs":
        [{"name": "_spender","type": "address"},{"name": "_value","type": "uint256"}],
        "name": "approve",
        "outputs": [{"name": "","type": "bool"}],
        "payable": false,
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

const erc20 = prepareEncodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
});

function createApproveCall(
    token: string,
    spender: string,
): DepositWalletCall {
    const calldata = encodeFunctionData({...erc20, args: [spender, maxUint256]});
    return {
        target: token,
        value: "0",
        data: calldata,
    };
}

async function main() {
    console.log(`Starting...`);

    const relayerUrl = `${process.env.RELAYER_URL}`;
    const chainId = parseInt(`${process.env.CHAIN_ID}`);
    const pk = privateKeyToAccount(`${process.env.PK}` as Hex);
    const wallet = createWalletClient({account: pk, chain: polygon, transport: http(`${process.env.RPC_URL}`)});

    const builderCreds: BuilderApiKeyCreds = {
        key: `${process.env.KUEST_BUILDER_API_KEY}`,
        secret: `${process.env.KUEST_BUILDER_SECRET}`,
        passphrase: `${process.env.KUEST_BUILDER_PASSPHRASE}`,
    };

    const builderConfig = new BuilderConfig({
        localBuilderCreds: builderCreds
    });

    const client = new RelayClient(relayerUrl, chainId, wallet, builderConfig);

    const walletAddress = `${process.env.DEPOSIT_WALLET_ADDRESS}`;

    const usdc = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";
    const ctf = "0x4682048725865bf17067bd85fF518527A262A9C7";

    // Build calls
    const approveCall = createApproveCall(usdc, ctf);

    // Deadline: 4 minutes from now
    const deadline = Math.floor(Date.now() / 1000 + 240).toString();

    // Execute batch on deposit wallet
    const resp = await client.executeDepositWalletBatch([approveCall], walletAddress, deadline);
    const res = await resp.wait();

    console.log(res);
    console.log(`Done!`);
}

main();
