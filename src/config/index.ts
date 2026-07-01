export interface DepositWalletContractConfig {
    DepositWalletFactory: string;
    DepositWalletBeacon: string;
    DepositWalletImplementation: string;
}

export interface ContractConfig {
    DepositWalletContracts: DepositWalletContractConfig;
}

const DEPOSIT_WALLET_CONFIG: DepositWalletContractConfig = {
    DepositWalletFactory: "0x2CcdC6C5dDcd895aFcCD259F291de9b618A5cA6c",
    DepositWalletBeacon: "0x74a618eBdd62Ff8579A8FE94f5B888d7623b9C35",
    DepositWalletImplementation: "0xf9dFAe108bF7d7aaa9E6D8c1aB281c6285BAF86c",
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
    return !!config.DepositWalletFactory && !!config.DepositWalletBeacon;
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
