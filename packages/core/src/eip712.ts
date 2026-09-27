import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  hashTypedData,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import type { Voucher } from "./types.js";

/** EIP-712 domain name/version: they must match `EIP712("L402-EL2", "1")` in the contract. */
export const EIP712_DOMAIN_NAME = "L402-EL2";
export const EIP712_DOMAIN_VERSION = "1";

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "nonce", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export const DELEGATION_TYPES = {
  Delegation: [
    { name: "payer", type: "address" },
    { name: "signer", type: "address" },
    { name: "maxCumulative", type: "uint256" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface Delegation {
  payer: Address;
  signer: Address;
  maxCumulative: bigint;
  validUntil: bigint;
  nonce: bigint;
}

export function buildDomain(chainId: number, escrow: Address): TypedDataDomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract: getAddress(escrow),
  };
}

/**
 * Computes the channelId exactly like `L402Escrow.computeChannelId`.
 * Lets the client sign without a single RPC call.
 */
export function computeChannelId(payer: Address, provider: Address, token: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }],
      [getAddress(payer), getAddress(provider), getAddress(token)],
    ),
  );
}

/** EIP-712 digest of a voucher (same as `escrow.voucherDigest`). */
export function voucherDigest(chainId: number, escrow: Address, voucher: Voucher): Hex {
  return hashTypedData({
    domain: buildDomain(chainId, escrow),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: voucher,
  });
}

export function delegationDigest(chainId: number, escrow: Address, delegation: Delegation): Hex {
  return hashTypedData({
    domain: buildDomain(chainId, escrow),
    types: DELEGATION_TYPES,
    primaryType: "Delegation",
    message: delegation,
  });
}

/** Payload ready for viem's `signTypedData` / external wallets. */
export function voucherTypedData(chainId: number, escrow: Address, voucher: Voucher) {
  return {
    domain: buildDomain(chainId, escrow),
    types: VOUCHER_TYPES,
    primaryType: "Voucher" as const,
    message: voucher,
  };
}

export function delegationTypedData(chainId: number, escrow: Address, delegation: Delegation) {
  return {
    domain: buildDomain(chainId, escrow),
    types: DELEGATION_TYPES,
    primaryType: "Delegation" as const,
    message: delegation,
  };
}
