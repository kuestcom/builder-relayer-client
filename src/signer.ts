export interface IAbstractSigner {
    getAddress(): Promise<string>;
    signTypedData(
        domain: Record<string, unknown>,
        types: Record<string, unknown>,
        value: Record<string, unknown>,
        primaryType: string,
    ): Promise<string>;
}

export function createAbstractSigner(_chainId: number, signer: any): IAbstractSigner {
    return {
        async getAddress(): Promise<string> {
            if (typeof signer.getAddress === "function") {
                return signer.getAddress();
            }
            if (signer.account?.address) {
                return signer.account.address;
            }
            throw new Error("signer address unavailable");
        },
        async signTypedData(domain, types, value, primaryType): Promise<string> {
            if (typeof signer._signTypedData === "function") {
                return signer._signTypedData(domain, types, value);
            }
            if (typeof signer.signTypedData === "function") {
                return signer.signTypedData({
                    account: signer.account,
                    domain,
                    types,
                    primaryType,
                    message: value,
                });
            }
            throw new Error("typed data signing unavailable");
        },
    };
}
