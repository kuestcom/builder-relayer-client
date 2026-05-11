export enum TransactionType {
    WALLET = "WALLET",
    WALLET_CREATE = "WALLET-CREATE",
}

export interface NoncePayload {
    nonce: string;
}

export enum RelayerTransactionState {
    STATE_NEW = "STATE_NEW",
    STATE_EXECUTED = "STATE_EXECUTED",
    STATE_MINED = "STATE_MINED",
    STATE_INVALID = "STATE_INVALID",
    STATE_CONFIRMED = "STATE_CONFIRMED",
    STATE_FAILED = "STATE_FAILED",
}

export interface RelayerTransaction {
    transactionID: string;
    transactionHash: string;
    from: string;
    to: string;
    walletAddress?: string;
    data: string;
    nonce: string;
    value: string;
    state: string;
    type: string;
    metadata: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface RelayerTransactionResponse {
    transactionID: string;
    state: string;
    hash: string;
    transactionHash: string;
    getTransaction: () => Promise<RelayerTransaction[]>;
    wait: () => Promise<RelayerTransaction | undefined>;
}

export interface GetDeployedResponse {
    deployed: boolean;
}

export interface DepositWalletCall {
    target: string;
    value: string;
    data: string;
}

export interface DepositWalletTransactionArgs {
    from: string;
    chainId: number;
    walletAddress: string;
    nonce: string;
    deadline: string;
    calls: DepositWalletCall[];
}

export interface DepositWalletParams {
    depositWallet: string;
    deadline: string;
    calls: DepositWalletCall[];
}

export interface DepositWalletBatchRequest {
    type: TransactionType.WALLET;
    from: string;
    to: string;
    nonce: string;
    signature: string;
    depositWalletParams: DepositWalletParams;
}

export interface DepositWalletCreateRequest {
    type: TransactionType.WALLET_CREATE;
    from: string;
    to: string;
}
