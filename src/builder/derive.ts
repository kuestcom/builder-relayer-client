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

const ERC1967_BEACON_CONST1: Hex = "0x60195155f3363d3d373d3d363d602036600436635c60da";
const ERC1967_BEACON_CONST2: Hex = "0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c";
const ERC1967_BEACON_CONST3: Hex = "0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3";
const ERC1967_BEACON_PREFIX = 0x6100523d8160233d3973n;

function initCodeHashERC1967BeaconProxy(beacon: Address, args: Hex): Hex {
    const n = BigInt((args.length - 2) / 2);
    const combined = ERC1967_BEACON_PREFIX + (n << 56n);

    return keccak256(
        concat([
            toHex(combined, { size: 10 }),
            beacon as Hex,
            ERC1967_BEACON_CONST1,
            ERC1967_BEACON_CONST2,
            ERC1967_BEACON_CONST3,
            args,
        ]),
    );
}

export const deriveDepositWallet = (
    owner: string,
    factory: string,
    beacon: string,
): string => {
    const walletId = pad(owner as Hex, { dir: "left", size: 32 });
    const args = encodeAbiParameters(
        [{ type: "address" }, { type: "bytes32" }],
        [factory as Address, walletId],
    );
    const salt = keccak256(args);
    const bytecodeHash = initCodeHashERC1967BeaconProxy(beacon as Address, args);

    return getCreate2Address({ from: factory as Hex, salt, bytecodeHash });
};
