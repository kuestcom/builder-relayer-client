export interface DepositWalletContractConfig {
    DepositWalletFactory: string;
    DepositWalletImplementation: string;
}

export interface ContractConfig {
    DepositWalletContracts: DepositWalletContractConfig;
}

const DEPOSIT_WALLET_CONFIG: DepositWalletContractConfig = {
    DepositWalletFactory: "0x3DaBe8f032833CE42CC26d9149660E6f596759C5",
    DepositWalletImplementation: "0xFB2f5D822Ecb062dE63a7B830C5e83C994698851",
};

const AMOY: ContractConfig = {
    DepositWalletContracts: DEPOSIT_WALLET_CONFIG,
};

const POLYGON: ContractConfig = {
    DepositWalletContracts: DEPOSIT_WALLET_CONFIG,
};

export function isDepositWalletContractConfigValid(
    config: DepositWalletContractConfig,
): boolean {
    return !!config.DepositWalletFactory && !!config.DepositWalletImplementation;
}

export const getContractConfig = (chainId: number): ContractConfig => {
    switch (chainId) {
        case 137:
            return POLYGON;
        case 80002:
            return AMOY;
        default:
            throw new Error("Invalid network");
    }
};
