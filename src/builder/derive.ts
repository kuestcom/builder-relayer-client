import {
    Address,
    Hex,
    concat,
    encodeAbiParameters,
    getCreate2Address,
    keccak256,
    pad,
    toHex,
} from "viem";

const ERC1967_CONST1: Hex = "0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const ERC1967_CONST2: Hex = "0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076";
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;

function initCodeHashERC1967(implementation: Address, args: Hex): Hex {
    const n = BigInt((args.length - 2) / 2);
    const combined = ERC1967_PREFIX + (n << 56n);

    return keccak256(
        concat([
            toHex(combined, { size: 10 }),
            implementation as Hex,
            "0x6009",
            ERC1967_CONST2,
            ERC1967_CONST1,
            args,
        ]),
    );
}

export const deriveDepositWallet = (
    owner: string,
    factory: string,
    implementation: string,
): string => {
    const walletId = pad(owner as Hex, { dir: "left", size: 32 });
    const args = encodeAbiParameters(
        [{ type: "address" }, { type: "bytes32" }],
        [factory as Address, walletId],
    );
    const salt = keccak256(args);
    const bytecodeHash = initCodeHashERC1967(implementation as Address, args);

    return getCreate2Address({ from: factory as Hex, salt, bytecodeHash });
};
