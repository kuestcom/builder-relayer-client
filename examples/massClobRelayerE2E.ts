import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { BuilderConfig } from "@kuestcom/builder-signing-sdk";
import {
    ClobClient,
    OrderType,
    Side,
    SignatureType,
} from "../../clob-client/src/index.ts";
import { RelayClient, RelayerTransactionState } from "../src/index.ts";
import {
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    formatUnits,
    http,
    maxUint256,
    zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const CHAIN_ID = 137;
const CLOB_URL = process.env.CLOB_URL || "https://clob.kuest.com";
const RELAYER_URL = process.env.RELAYER_URL || "https://relayer.kuest.com";
const RPC_URL = process.env.RPC_URL || "https://polygon.drpc.org";
const SPLIT_AMOUNT_USDC = Number(process.env.MASS_SPLIT_USDC || "100");
const SPLIT_AMOUNT = BigInt(Math.round(SPLIT_AMOUNT_USDC * 1_000_000));
const POLL_MS = Number(process.env.MASS_POLL_MS || "1500");
const CLEANUP_ONLY = process.env.MASS_CLEANUP_ONLY === "1";
const LOG_PATH = process.env.MASS_TEST_LOG || resolve(
    process.cwd(),
    "test-results",
    `mass-e2e-${new Date().toISOString().replaceAll(":", "-")}.jsonl`,
);

const CONTRACTS = {
    collateral: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    conditionalTokens: "0x4682048725865bf17067bd85fF518527A262A9C7",
    exchange: "0xaa1b8dE834E16eC69C044F5300041673C968c9eF",
} as const;

const erc20Abi = [
    {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
    },
] as const;

const conditionalTokensAbi = [
    {
        type: "function",
        name: "splitPosition",
        stateMutability: "nonpayable",
        inputs: [
            { type: "address" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint256[]" },
            { type: "uint256" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "mergePositions",
        stateMutability: "nonpayable",
        inputs: [
            { type: "address" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint256[]" },
            { type: "uint256" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "setApprovalForAll",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "bool" }],
        outputs: [],
    },
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "uint256" }],
    },
] as const;

type WalletContext = {
    name: string;
    address: `0x${string}`;
    depositWallet: `0x${string}`;
    clob: ClobClient;
    relay: RelayClient;
    initialUsdc: bigint;
};

type MarketContext = {
    conditionId: `0x${string}`;
    question: string;
    tokenIds: [string, string];
    tickSize: string;
    minOrderSize: number;
};

type TrackedOrder = {
    wallet: WalletContext;
    id: string;
    label: string;
};

const publicClient = createPublicClient({
    chain: polygon,
    transport: http(RPC_URL, { timeout: 15_000, retryCount: 2 }),
});

const trackedOrders: TrackedOrder[] = [];
const unexpectedFailures: Array<{ step: string; error: string }> = [];
let testStartedAtSeconds = Math.floor(Date.now() / 1000) - 5;

mkdirSync(dirname(LOG_PATH), { recursive: true });
writeFileSync(LOG_PATH, "", { mode: 0o600 });

function sleep(ms: number) {
    return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function safeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message.slice(0, 1_000);
    }
    return String(error).slice(0, 1_000);
}

function redact(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(redact);
    }
    if (value && typeof value === "object") {
        const clean: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            if (/^(secret|passphrase|signature|apiKey|privateKey|headers)$/i.test(key)) {
                clean[key] = "[REDACTED]";
            } else {
                clean[key] = redact(child);
            }
        }
        return clean;
    }
    return value;
}

function log(event: string, status: string, details: Record<string, unknown> = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        event,
        status,
        ...redact(details) as Record<string, unknown>,
    };
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
    console.log(`[${entry.timestamp}] ${status.padEnd(7)} ${event}`);
}

async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    log(name, "START");
    try {
        const result = await action();
        log(name, "PASS", { durationMs: Date.now() - started });
        return result;
    } catch (error) {
        const message = safeError(error);
        unexpectedFailures.push({ step: name, error: message });
        log(name, "FAIL", { durationMs: Date.now() - started, error: message });
        throw error;
    }
}

function privateKey(name: string): `0x${string}` {
    const raw = process.env[name] || process.env[name.toUpperCase()];
    if (!raw) {
        throw new Error(`${name} is missing from the sourced environment`);
    }
    const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
        throw new Error(`${name} is not a valid private key`);
    }
    return normalized as `0x${string}`;
}

async function usdcBalance(address: `0x${string}`): Promise<bigint> {
    return publicClient.readContract({
        address: CONTRACTS.collateral,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
    });
}

async function tokenBalance(address: `0x${string}`, tokenId: string): Promise<bigint> {
    return publicClient.readContract({
        address: CONTRACTS.conditionalTokens,
        abi: conditionalTokensAbi,
        functionName: "balanceOf",
        args: [address, BigInt(tokenId)],
    });
}

async function initializeWallet(name: string): Promise<WalletContext> {
    const account = privateKeyToAccount(privateKey(name));
    const signer = createWalletClient({
        account,
        chain: polygon,
        transport: http(RPC_URL, { timeout: 15_000, retryCount: 2 }),
    });

    const authClient = new ClobClient(CLOB_URL, CHAIN_ID, signer as any, undefined, undefined, undefined, undefined, true);
    const creds = await authClient.createOrDeriveApiKey();
    if (!creds?.key || !creds?.secret || !creds?.passphrase) {
        throw new Error(`${name} could not derive complete CLOB credentials`);
    }

    const unauthenticatedRelay = new RelayClient(RELAYER_URL, CHAIN_ID, signer as any);
    const depositWallet = await unauthenticatedRelay.deriveDepositWallet() as `0x${string}`;
    const deployed = await unauthenticatedRelay.getDeployed(depositWallet);
    if (!deployed) {
        throw new Error(`${name} Deposit Wallet is not deployed`);
    }

    const builderConfig = new BuilderConfig({
        localBuilderCreds: {
            key: creds.key,
            secret: creds.secret,
            passphrase: creds.passphrase,
        },
    });
    const relay = new RelayClient(RELAYER_URL, CHAIN_ID, signer as any, builderConfig);
    const clob = new ClobClient(
        CLOB_URL,
        CHAIN_ID,
        signer as any,
        creds,
        SignatureType.DEPOSIT_WALLET,
        depositWallet,
        undefined,
        true,
    );
    const initialUsdc = await usdcBalance(depositWallet);
    const balanceAllowance = await clob.getBalanceAllowance({ asset_type: "COLLATERAL" } as never);

    log("wallet_initialized", "INFO", {
        wallet: name,
        address: account.address,
        depositWallet,
        relayerDeployed: deployed,
        onchainUsdc: formatUnits(initialUsdc, 6),
        clobCollateralBalance: balanceAllowance?.balance,
        clobAllowances: balanceAllowance?.allowances,
    });

    return {
        name,
        address: account.address,
        depositWallet,
        clob,
        relay,
        initialUsdc,
    };
}

function bookSummary(book: any) {
    return {
        market: book?.market,
        assetId: book?.asset_id,
        timestamp: book?.timestamp,
        bids: Array.isArray(book?.bids) ? book.bids.map((level: any) => ({ price: level.price, size: level.size })) : [],
        asks: Array.isArray(book?.asks) ? book.asks.map((level: any) => ({ price: level.price, size: level.size })) : [],
    };
}

function levelSize(book: any, side: "bids" | "asks", price: number): number {
    const level = (book?.[side] || []).find((candidate: any) => Math.abs(Number(candidate.price) - price) < 1e-9);
    return Number(level?.size || 0);
}

async function snapshot(market: MarketContext, label: string) {
    const book = await new ClobClient(CLOB_URL, CHAIN_ID).getOrderBook(market.tokenIds[0]);
    log("book_snapshot", "INFO", { label, book: bookSummary(book) });
    return book;
}

async function waitForBook(
    market: MarketContext,
    label: string,
    predicate: (book: any) => boolean,
    timeoutMs = 20_000,
) {
    const deadline = Date.now() + timeoutMs;
    let lastBook: any;
    while (Date.now() < deadline) {
        lastBook = await snapshot(market, label);
        if (predicate(lastBook)) {
            return lastBook;
        }
        await sleep(POLL_MS);
    }
    throw new Error(`${label}: order book condition timed out; last=${JSON.stringify(bookSummary(lastBook))}`);
}

async function selectMarket(wallets: WalletContext[]): Promise<MarketContext> {
    const page = await new ClobClient(CLOB_URL, CHAIN_ID).getSamplingMarkets();
    const candidates = (page?.data || []).filter((market: any) =>
        market.active === true
        && market.accepting_orders === true
        && market.neg_risk === false
        && Array.isArray(market.tokens)
        && market.tokens.length === 2,
    );

    for (const candidate of candidates) {
        const tokenIds = candidate.tokens.map((token: any) => String(token.token_id)) as [string, string];
        const book = await new ClobClient(CLOB_URL, CHAIN_ID).getOrderBook(tokenIds[0]);
        const isEmptyBook = (book?.bids?.length || 0) === 0 && (book?.asks?.length || 0) === 0;
        if (!isEmptyBook) {
            continue;
        }

        const balances = await Promise.all(wallets.flatMap(wallet =>
            tokenIds.map(tokenId => tokenBalance(wallet.depositWallet, tokenId)),
        ));
        const hasNoPositions = balances.every(balance => balance === 0n);
        if (!hasNoPositions) {
            continue;
        }

        const openOrders = await Promise.all(wallets.map(wallet =>
            wallet.clob.getOpenOrders({ market: candidate.condition_id }, true),
        ));
        const hasNoExistingOrders = openOrders.every(orders => orders.length === 0);
        if (hasNoExistingOrders) {
            const selected = {
                conditionId: candidate.condition_id as `0x${string}`,
                question: candidate.question,
                tokenIds,
                tickSize: String(candidate.minimum_tick_size || book.tick_size || "0.01"),
                minOrderSize: Number(candidate.minimum_order_size || book.min_order_size || 5),
            };
            log("market_selected", "INFO", selected);
            return selected;
        }
    }
    throw new Error("No active non-neg-risk market with an empty book and zero prior wallet positions was found");
}

function relayCall(target: `0x${string}`, data: `0x${string}`) {
    return { target, value: "0", data };
}

function splitCall(market: MarketContext, amount = SPLIT_AMOUNT) {
    return relayCall(CONTRACTS.conditionalTokens, encodeFunctionData({
        abi: conditionalTokensAbi,
        functionName: "splitPosition",
        args: [CONTRACTS.collateral, zeroHash, market.conditionId, [1n, 2n], amount],
    }));
}

function mergeCall(market: MarketContext, amount: bigint) {
    return relayCall(CONTRACTS.conditionalTokens, encodeFunctionData({
        abi: conditionalTokensAbi,
        functionName: "mergePositions",
        args: [CONTRACTS.collateral, zeroHash, market.conditionId, [1n, 2n], amount],
    }));
}

function approvalCalls() {
    return [
        relayCall(CONTRACTS.collateral, encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [CONTRACTS.conditionalTokens, maxUint256],
        })),
        relayCall(CONTRACTS.conditionalTokens, encodeFunctionData({
            abi: conditionalTokensAbi,
            functionName: "setApprovalForAll",
            args: [CONTRACTS.exchange, true],
        })),
    ];
}

async function executeRelay(wallet: WalletContext, label: string, calls: ReturnType<typeof relayCall>[]) {
    const deadline = String(Math.floor(Date.now() / 1000) + 10 * 60);
    const response = await wallet.relay.executeDepositWalletBatch(calls, wallet.depositWallet, deadline);
    log("relayer_submit", "INFO", {
        label,
        wallet: wallet.name,
        transactionID: response.transactionID,
        initialState: response.state,
        transactionHash: response.transactionHash,
        callCount: calls.length,
    });

    for (let poll = 0; poll < 120; poll += 1) {
        const transactions = await wallet.relay.getTransaction(response.transactionID);
        const transaction = transactions[0];
        if (transaction) {
            log("relayer_poll", "INFO", {
                label,
                wallet: wallet.name,
                transactionID: response.transactionID,
                state: transaction.state,
                transactionHash: transaction.transactionHash,
            });
            if ([RelayerTransactionState.STATE_MINED, RelayerTransactionState.STATE_CONFIRMED].includes(transaction.state as RelayerTransactionState)) {
                return transaction;
            }
            if ([RelayerTransactionState.STATE_FAILED, RelayerTransactionState.STATE_INVALID].includes(transaction.state as RelayerTransactionState)) {
                throw new Error(`${label}: relayer transaction ${response.transactionID} ended in ${transaction.state}`);
            }
        }
        await sleep(POLL_MS);
    }
    throw new Error(`${label}: relayer transaction ${response.transactionID} timed out`);
}

async function waitForTokenBalances(wallets: WalletContext[], market: MarketContext, expected: bigint) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
        const balances = await Promise.all(wallets.flatMap(wallet => market.tokenIds.map(tokenId => tokenBalance(wallet.depositWallet, tokenId))));
        if (balances.every(balance => balance === expected)) {
            return;
        }
        await sleep(POLL_MS);
    }
    throw new Error(`Split balances did not reach ${expected.toString()} for every wallet/token`);
}

function orderResponse(response: any) {
    return {
        success: response?.success,
        error: response?.error || response?.errorMsg,
        status: response?.status,
        orderID: response?.orderID,
        takingAmount: response?.takingAmount,
        makingAmount: response?.makingAmount,
        transactionsHashes: response?.transactionsHashes,
    };
}

function assertOrderSuccess(response: any, label: string): string {
    if (response?.error || response?.success === false || !response?.orderID) {
        throw new Error(`${label}: order failed: ${JSON.stringify(orderResponse(response))}`);
    }
    return response.orderID;
}

function assertExpectedOrderFailure(response: any, label: string) {
    if (response?.orderID && response?.success !== false && !response?.error) {
        throw new Error(`${label}: expected rejection but order ${response.orderID} was accepted`);
    }
}

async function createSignedOrder(
    wallet: WalletContext,
    market: MarketContext,
    side: Side,
    price: number,
    size: number,
    expiration = 0,
) {
    return wallet.clob.createOrder(
        { tokenID: market.tokenIds[0], side, price, size, expiration },
        { tickSize: market.tickSize as any, negRisk: false },
    );
}

async function postLimit(
    wallet: WalletContext,
    market: MarketContext,
    label: string,
    side: Side,
    price: number,
    size: number,
    type: OrderType,
    options: { postOnly?: boolean; expiration?: number; expectFailure?: boolean } = {},
) {
    const signed = await createSignedOrder(wallet, market, side, price, size, options.expiration || 0);
    const response = await wallet.clob.postOrder(signed, type, false, options.postOnly || false);
    log("order_submit", "INFO", {
        label,
        wallet: wallet.name,
        request: { side, price, size, type, postOnly: options.postOnly || false, expiration: options.expiration || 0 },
        response: orderResponse(response),
    });
    await snapshot(market, `${label}:after_submit`);
    if (options.expectFailure) {
        assertExpectedOrderFailure(response, label);
        return undefined;
    }
    const id = assertOrderSuccess(response, label);
    trackedOrders.push({ wallet, id, label });
    return { id, response, signed };
}

async function cancelSingle(order: TrackedOrder, market: MarketContext, label: string) {
    const response = await order.wallet.clob.cancelOrder({ orderID: order.id });
    log("order_cancel", "INFO", { label, wallet: order.wallet.name, orderID: order.id, response });
    await snapshot(market, `${label}:after_cancel`);
    return response;
}

async function runClobMatrix(wallets: WalletContext[], market: MarketContext) {
    const [w1, w2, w3, w4] = wallets;
    const size = Math.max(5, market.minOrderSize);

    await step("clob_batch_15_per_side", async () => {
        const buys = await Promise.all(Array.from({ length: 15 }, (_, index) =>
            createSignedOrder(w1, market, Side.BUY, 0.10 + index * 0.01, size),
        ));
        const sells = await Promise.all(Array.from({ length: 15 }, (_, index) =>
            createSignedOrder(w2, market, Side.SELL, 0.76 + index * 0.01, size),
        ));
        const [buyResponses, sellResponses] = await Promise.all([
            w1.clob.postOrders(buys.map(order => ({ order, orderType: OrderType.GTC }))),
            w2.clob.postOrders(sells.map(order => ({ order, orderType: OrderType.GTC }))),
        ]);
        log("batch_order_submit", "INFO", {
            wallet: w1.name,
            count: buyResponses?.length,
            responses: (buyResponses || []).map(orderResponse),
        });
        log("batch_order_submit", "INFO", {
            wallet: w2.name,
            count: sellResponses?.length,
            responses: (sellResponses || []).map(orderResponse),
        });
        const buyIds = (buyResponses || []).map((response: any, index: number) => {
            const id = assertOrderSuccess(response, `batch_buy_${index}`);
            trackedOrders.push({ wallet: w1, id, label: `batch_buy_${index}` });
            return id;
        });
        const sellIds = (sellResponses || []).map((response: any, index: number) => {
            const id = assertOrderSuccess(response, `batch_sell_${index}`);
            trackedOrders.push({ wallet: w2, id, label: `batch_sell_${index}` });
            return id;
        });
        await waitForBook(market, "batch_depth", book => book.bids.length >= 15 && book.asks.length >= 15);
        const [buyCancel, sellCancel] = await Promise.all([
            w1.clob.cancelOrders(buyIds),
            w2.clob.cancelOrders(sellIds),
        ]);
        log("batch_order_cancel", "INFO", { wallet: w1.name, response: buyCancel });
        log("batch_order_cancel", "INFO", { wallet: w2.name, response: sellCancel });
        await waitForBook(market, "batch_cancelled", book => book.bids.length === 0 && book.asks.length === 0);
    });

    await step("clob_idempotent_resubmit_and_double_cancel", async () => {
        const signed = await createSignedOrder(w1, market, Side.BUY, 0.30, size);
        const first = await w1.clob.postOrder(signed, OrderType.GTC);
        await snapshot(market, "idempotency:first");
        const second = await w1.clob.postOrder(signed, OrderType.GTC);
        await snapshot(market, "idempotency:second");
        const firstId = assertOrderSuccess(first, "idempotency_first");
        const secondId = assertOrderSuccess(second, "idempotency_second");
        log("idempotency_result", firstId === secondId ? "PASS" : "FAIL", {
            first: orderResponse(first),
            second: orderResponse(second),
        });
        if (firstId !== secondId) {
            throw new Error(`Idempotent resubmit returned different IDs: ${firstId} / ${secondId}`);
        }
        const tracked = { wallet: w1, id: firstId, label: "idempotency" };
        trackedOrders.push(tracked);
        await cancelSingle(tracked, market, "idempotency:first_cancel");
        const secondCancel = await w1.clob.cancelOrder({ orderID: firstId });
        log("order_double_cancel", "INFO", { orderID: firstId, response: secondCancel });
        await snapshot(market, "idempotency:double_cancel");
    });

    await step("clob_gtd_and_market_cancel", async () => {
        const expiration = Math.floor(Date.now() / 1000) + 240;
        await postLimit(w3, market, "gtd_resting", Side.BUY, 0.31, size, OrderType.GTD, { expiration });
        await waitForBook(market, "gtd_visible", book => levelSize(book, "bids", 0.31) >= size);
        const response = await w3.clob.cancelMarketOrders({ market: market.conditionId, asset_id: market.tokenIds[0] });
        log("market_cancel", "INFO", { wallet: w3.name, response });
        await waitForBook(market, "gtd_market_cancelled", book => levelSize(book, "bids", 0.31) === 0);
    });

    await step("clob_short_gtd_sdk_validation", async () => {
        const signed = await createSignedOrder(w3, market, Side.BUY, 0.32, size, Math.floor(Date.now() / 1000) + 60);
        let rejected = false;
        try {
            await w3.clob.postOrder(signed, OrderType.GTD);
        } catch (error) {
            rejected = /at least 3 minutes/i.test(safeError(error));
            log("expected_sdk_rejection", rejected ? "PASS" : "FAIL", { error: safeError(error) });
        }
        await snapshot(market, "short_gtd:after_attempt");
        if (!rejected) {
            throw new Error("Short GTD was not rejected by the TypeScript SDK");
        }
    });

    await step("clob_post_only", async () => {
        const ask = await postLimit(w2, market, "post_only_reference_ask", Side.SELL, 0.60, size, OrderType.GTC);
        await waitForBook(market, "post_only_reference_visible", book => levelSize(book, "asks", 0.60) >= size);
        await postLimit(w1, market, "post_only_cross_rejected", Side.BUY, 0.61, size, OrderType.GTC, { postOnly: true, expectFailure: true });
        await waitForBook(market, "post_only_cross_preserved_book", book => levelSize(book, "asks", 0.60) >= size);
        const bid = await postLimit(w1, market, "post_only_resting_bid", Side.BUY, 0.59, size, OrderType.GTC, { postOnly: true });
        await waitForBook(market, "post_only_both_sides", book => levelSize(book, "bids", 0.59) >= size && levelSize(book, "asks", 0.60) >= size);
        await Promise.all([
            cancelSingle({ wallet: w2, id: ask!.id, label: "post_only_ask" }, market, "post_only_cancel_ask"),
            cancelSingle({ wallet: w1, id: bid!.id, label: "post_only_bid" }, market, "post_only_cancel_bid"),
        ]);
        await waitForBook(market, "post_only_empty", book => book.bids.length === 0 && book.asks.length === 0);
    });

    await step("clob_gtc_cross", async () => {
        await postLimit(w1, market, "gtc_cross_bid", Side.BUY, 0.50, size * 2, OrderType.GTC);
        await waitForBook(market, "gtc_cross_bid_visible", book => levelSize(book, "bids", 0.50) >= size * 2);
        await postLimit(w2, market, "gtc_cross_ask", Side.SELL, 0.50, size * 2, OrderType.GTC);
        await waitForBook(market, "gtc_cross_matched", book => levelSize(book, "bids", 0.50) === 0 && levelSize(book, "asks", 0.50) === 0);
    });

    await step("clob_fok_kill_then_fill", async () => {
        await postLimit(w3, market, "fok_reference_ask", Side.SELL, 0.55, size, OrderType.GTC);
        await waitForBook(market, "fok_reference_visible", book => levelSize(book, "asks", 0.55) >= size);
        await postLimit(w4, market, "fok_insufficient_liquidity", Side.BUY, 0.55, size * 2, OrderType.FOK, { expectFailure: true });
        await waitForBook(market, "fok_kill_preserved_book", book => levelSize(book, "asks", 0.55) >= size);
        await postLimit(w4, market, "fok_full_fill", Side.BUY, 0.55, size, OrderType.FOK);
        await waitForBook(market, "fok_filled", book => levelSize(book, "asks", 0.55) === 0 && levelSize(book, "bids", 0.55) === 0);
    });

    await step("clob_fak_partial_fill", async () => {
        await postLimit(w1, market, "fak_reference_ask", Side.SELL, 0.60, size, OrderType.GTC);
        await waitForBook(market, "fak_reference_visible", book => levelSize(book, "asks", 0.60) >= size);
        await postLimit(w2, market, "fak_partial", Side.BUY, 0.60, size + 3, OrderType.FAK);
        await waitForBook(market, "fak_partial_remainder_killed", book => levelSize(book, "asks", 0.60) === 0 && levelSize(book, "bids", 0.60) === 0);
    });

    await step("clob_fak_multi_level_sweep", async () => {
        await postLimit(w2, market, "sweep_ask_65", Side.SELL, 0.65, size, OrderType.GTC);
        await postLimit(w3, market, "sweep_ask_66", Side.SELL, 0.66, size, OrderType.GTC);
        const last = await postLimit(w4, market, "sweep_ask_67", Side.SELL, 0.67, size, OrderType.GTC);
        await waitForBook(market, "sweep_three_levels", book =>
            levelSize(book, "asks", 0.65) >= size
            && levelSize(book, "asks", 0.66) >= size
            && levelSize(book, "asks", 0.67) >= size,
        );
        await postLimit(w1, market, "sweep_fak_taker", Side.BUY, 0.67, size * 2 + 2, OrderType.FAK);
        await waitForBook(market, "sweep_partial_last_level", book =>
            levelSize(book, "asks", 0.65) === 0
            && levelSize(book, "asks", 0.66) === 0
            && Math.abs(levelSize(book, "asks", 0.67) - (size - 2)) < 1e-9,
        );
        await cancelSingle({ wallet: w4, id: last!.id, label: "sweep_remaining_ask" }, market, "sweep_cancel_remainder");
        await waitForBook(market, "sweep_empty", book => book.bids.length === 0 && book.asks.length === 0);
    });

    await step("clob_post_only_fok_sdk_validation", async () => {
        const signed = await createSignedOrder(w1, market, Side.BUY, 0.40, size);
        let rejected = false;
        try {
            await w1.clob.postOrder(signed, OrderType.FOK, false, true);
        } catch (error) {
            rejected = /postOnly is only supported/i.test(safeError(error));
            log("expected_sdk_rejection", rejected ? "PASS" : "FAIL", { error: safeError(error) });
        }
        await snapshot(market, "post_only_fok:after_attempt");
        if (!rejected) {
            throw new Error("postOnly FOK was not rejected by the TypeScript SDK");
        }
    });
}

async function cancelTrackedOpenOrders(wallets: WalletContext[], market: MarketContext) {
    for (const wallet of wallets) {
        try {
            const open = await wallet.clob.getOpenOrders(
                { market: market.conditionId, asset_id: market.tokenIds[0] },
                true,
            );
            const trackedIds = new Set(trackedOrders.filter(order => order.wallet === wallet).map(order => order.id));
            const ids = open.filter(order => trackedIds.has(order.id)).map(order => order.id);
            if (ids.length > 0) {
                const response = await wallet.clob.cancelOrders(ids);
                log("cleanup_cancel_orders", "INFO", { wallet: wallet.name, ids, response });
            }
        } catch (error) {
            log("cleanup_cancel_orders", "FAIL", { wallet: wallet.name, error: safeError(error) });
        }
    }
    await snapshot(market, "cleanup_after_cancels");
}

async function waitForSettlements(wallets: WalletContext[], market: MarketContext, expectedTrades = 6) {
    const deadline = Date.now() + 4 * 60_000;
    let latest = new Map<string, any>();
    while (Date.now() < deadline) {
        const pages = await Promise.all(wallets.map(wallet => wallet.clob.getTrades({
            market: market.conditionId,
            after: String(testStartedAtSeconds),
        } as never, true)));
        latest = new Map(pages.flat().map(trade => [trade.id, trade]));
        const states = [...latest.values()].map(trade => ({ id: trade.id, status: trade.status, txHash: trade.transaction_hash }));
        log("settlement_poll", "INFO", { uniqueTrades: latest.size, states });
        if (latest.size >= expectedTrades && [...latest.values()].every(trade => ["CONFIRMED", "FAILED"].includes(trade.status))) {
            const failed = [...latest.values()].filter(trade => trade.status === "FAILED");
            if (failed.length > 0) {
                throw new Error(`${failed.length} CLOB trades reached FAILED settlement state`);
            }
            return [...latest.values()];
        }
        await sleep(Math.max(POLL_MS, 2_000));
    }
    throw new Error(`CLOB settlement timed out with ${latest.size} unique trades`);
}

async function consolidateAndMerge(wallets: WalletContext[], market: MarketContext) {
    const balances = await Promise.all(wallets.map(async wallet => ({
        wallet,
        outcomes: await Promise.all(market.tokenIds.map(tokenId => tokenBalance(wallet.depositWallet, tokenId))),
    })));
    const total0 = balances.reduce((sum, entry) => sum + entry.outcomes[0], 0n);
    const total1 = balances.reduce((sum, entry) => sum + entry.outcomes[1], 0n);
    if (total0 !== total1) {
        throw new Error(`Cannot rebalance unequal aggregate outcomes: ${total0.toString()} / ${total1.toString()}`);
    }

    const sellers = balances
        .filter(entry => entry.outcomes[0] > entry.outcomes[1])
        .map(entry => ({ ...entry, remaining: entry.outcomes[0] - entry.outcomes[1] }));
    const buyers = balances
        .filter(entry => entry.outcomes[0] < entry.outcomes[1])
        .map(entry => ({ ...entry, remaining: entry.outcomes[1] - entry.outcomes[0] }));

    log("cleanup_rebalance_plan", "INFO", {
        balances: balances.map(entry => ({
            wallet: entry.wallet.name,
            outcome0: formatUnits(entry.outcomes[0], 6),
            outcome1: formatUnits(entry.outcomes[1], 6),
        })),
        sellers: sellers.map(entry => ({ wallet: entry.wallet.name, amount: formatUnits(entry.remaining, 6) })),
        buyers: buyers.map(entry => ({ wallet: entry.wallet.name, amount: formatUnits(entry.remaining, 6) })),
    });

    if (sellers.length > 0 || buyers.length > 0) {
        testStartedAtSeconds = Math.floor(Date.now() / 1000) - 5;
        let expectedTrades = 0;
        for (const buyer of buyers) {
            const target = buyer.remaining;
            const targetSize = Number(formatUnits(target, 6));
            const postedSize = Math.max(targetSize, market.minOrderSize);
            const bid = await postLimit(
                buyer.wallet,
                market,
                `cleanup_rebalance_bid_${buyer.wallet.name}`,
                Side.BUY,
                0.50,
                postedSize,
                OrderType.GTC,
            );
            await waitForBook(market, `cleanup_rebalance_bid_visible_${buyer.wallet.name}`, book =>
                levelSize(book, "bids", 0.50) >= postedSize,
            );

            while (buyer.remaining > 0n) {
                const seller = sellers.find(candidate => candidate.remaining > 0n);
                if (!seller) {
                    throw new Error(`No seller available for ${buyer.wallet.name} remaining deficit`);
                }
                const amount = seller.remaining < buyer.remaining ? seller.remaining : buyer.remaining;
                const amountSize = Number(formatUnits(amount, 6));
                await postLimit(
                    seller.wallet,
                    market,
                    `cleanup_rebalance_sell_${seller.wallet.name}_to_${buyer.wallet.name}`,
                    Side.SELL,
                    0.50,
                    Math.max(amountSize, market.minOrderSize),
                    OrderType.FAK,
                );
                expectedTrades += 1;
                seller.remaining -= amount;
                buyer.remaining -= amount;
            }

            if (postedSize > targetSize) {
                await cancelSingle(
                    { wallet: buyer.wallet, id: bid!.id, label: `cleanup_rebalance_bid_${buyer.wallet.name}` },
                    market,
                    `cleanup_rebalance_cancel_residual_${buyer.wallet.name}`,
                );
            }
        }
        await waitForBook(market, "cleanup_rebalance_book_empty", book => book.bids.length === 0 && book.asks.length === 0);
        await waitForSettlements(wallets, market, expectedTrades);
    }

    const mergeBalances = await Promise.all(wallets.map(async wallet => ({
        wallet,
        outcomes: await Promise.all(market.tokenIds.map(tokenId => tokenBalance(wallet.depositWallet, tokenId))),
    })));
    for (const entry of mergeBalances) {
        if (entry.outcomes[0] !== entry.outcomes[1]) {
            throw new Error(`${entry.wallet.name} outcomes are still unequal before merge: ${entry.outcomes[0]} / ${entry.outcomes[1]}`);
        }
    }
    await Promise.all(mergeBalances.map(entry => {
        log("cleanup_merge_ready", "INFO", {
            wallet: entry.wallet.name,
            balances: entry.outcomes.map(balance => formatUnits(balance, 6)),
            mergeAmount: formatUnits(entry.outcomes[0], 6),
        });
        return entry.outcomes[0] > 0n
            ? executeRelay(entry.wallet, `cleanup_merge_${entry.wallet.name}`, [mergeCall(market, entry.outcomes[0])])
            : Promise.resolve();
    }));

    const finalTokenBalances = await Promise.all(wallets.flatMap(wallet =>
        market.tokenIds.map(tokenId => tokenBalance(wallet.depositWallet, tokenId)),
    ));
    const finalUsdc = await Promise.all(wallets.map(wallet => usdcBalance(wallet.depositWallet)));
    log("cleanup_final_balances", finalTokenBalances.every(balance => balance === 0n) ? "PASS" : "WARN", {
        tokenBalances: finalTokenBalances.map(balance => formatUnits(balance, 6)),
        usdc: wallets.map((wallet, index) => ({
            wallet: wallet.name,
            before: formatUnits(wallet.initialUsdc, 6),
            after: formatUnits(finalUsdc[index], 6),
            delta: formatUnits(finalUsdc[index] - wallet.initialUsdc, 6),
        })),
        aggregateUsdcDelta: formatUnits(
            finalUsdc.reduce((sum, balance) => sum + balance, 0n)
            - wallets.reduce((sum, wallet) => sum + wallet.initialUsdc, 0n),
            6,
        ),
    });
}

async function main() {
    log("run_started", "INFO", {
        clobUrl: CLOB_URL,
        relayerUrl: RELAYER_URL,
        chainId: CHAIN_ID,
        splitAmountUsdc: SPLIT_AMOUNT_USDC,
        logPath: LOG_PATH,
    });

    let wallets: WalletContext[] = [];
    let market: MarketContext | undefined;
    try {
        wallets = await step("initialize_four_wallets", () => Promise.all(["pk1", "pk2", "pk3", "pk4"].map(initializeWallet)));
        if (CLEANUP_ONLY) {
            const conditionId = process.env.MASS_CLEANUP_CONDITION as `0x${string}` | undefined;
            const token0 = process.env.MASS_CLEANUP_TOKEN0;
            const token1 = process.env.MASS_CLEANUP_TOKEN1;
            if (!conditionId || !token0 || !token1) {
                throw new Error("Cleanup mode requires MASS_CLEANUP_CONDITION, MASS_CLEANUP_TOKEN0, and MASS_CLEANUP_TOKEN1");
            }
            market = {
                conditionId,
                question: "cleanup recovery",
                tokenIds: [token0, token1],
                tickSize: "0.01",
                minOrderSize: 5,
            };
            log("cleanup_recovery_market", "INFO", market);
            await step("cleanup_recovery_consolidate_and_merge", () => consolidateAndMerge(wallets, market!));
        } else {
            market = await step("select_isolated_market", () => selectMarket(wallets));
            testStartedAtSeconds = Math.floor(Date.now() / 1000) - 5;

            await step("relayer_parallel_splits", async () => {
                await Promise.all(wallets.map((wallet, index) => executeRelay(
                    wallet,
                    `split_${wallet.name}`,
                    index === 0 ? [...approvalCalls(), splitCall(market!)] : [splitCall(market!)],
                )));
                await waitForTokenBalances(wallets, market!, SPLIT_AMOUNT);
                const balances = await Promise.all(wallets.map(wallet => usdcBalance(wallet.depositWallet)));
                log("split_verified", "PASS", {
                    positionPerOutcome: formatUnits(SPLIT_AMOUNT, 6),
                    usdc: wallets.map((wallet, index) => ({ wallet: wallet.name, balance: formatUnits(balances[index], 6) })),
                });
            });

            await runClobMatrix(wallets, market);
            await step("clob_settlement_confirmation", () => waitForSettlements(wallets, market!));
        }
    } catch (error) {
        log("run_error", "FAIL", { error: safeError(error) });
    } finally {
        if (!CLEANUP_ONLY && wallets.length === 4 && market) {
            await cancelTrackedOpenOrders(wallets, market);
            try {
                await waitForSettlements(wallets, market);
            } catch (error) {
                log("cleanup_settlement_wait", "WARN", { error: safeError(error) });
            }
            try {
                await consolidateAndMerge(wallets, market);
            } catch (error) {
                unexpectedFailures.push({ step: "cleanup_consolidate_and_merge", error: safeError(error) });
                log("cleanup_consolidate_and_merge", "FAIL", { error: safeError(error) });
            }
        }
    }

    log("run_finished", unexpectedFailures.length === 0 ? "PASS" : "FAIL", {
        unexpectedFailureCount: unexpectedFailures.length,
        unexpectedFailures,
        logPath: LOG_PATH,
    });
    console.log(`LOG_PATH=${LOG_PATH}`);
    if (unexpectedFailures.length > 0) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    log("uncaught_error", "FAIL", { error: safeError(error) });
    console.log(`LOG_PATH=${LOG_PATH}`);
    process.exitCode = 1;
});
