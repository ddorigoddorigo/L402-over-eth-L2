import type { Address, Hex } from "viem";

/** Name of the HTTP authentication scheme. */
export const L402_SCHEME = "L402" as const;

/** Version of the EVM profile of the protocol. */
export const L402_EL2_VERSION = 1 as const;

/**
 * Cumulative-amount voucher: the "proof of payment" of the protocol.
 *
 * It replaces the Lightning preimage of the original L402. Each voucher
 * authorizes the provider to collect up to `cumulativeAmount` in total from the
 * channel: voucher N+1 makes voucher N useless, so the provider only needs to
 * keep the latest one.
 */
export interface Voucher {
  /** keccak256(abi.encode(payer, provider, token)) */
  channelId: Hex;
  /** Total authorized so far, in token base units (cbBTC: 8 decimals). */
  cumulativeAmount: bigint;
  /** Monotonic counter, useful for ordering and diagnostics. */
  nonce: bigint;
  /** Unix time (seconds) after which the voucher can no longer be settled. */
  validUntil: bigint;
}

/** A signed voucher, as it travels in the Authorization header. */
export interface SignedVoucher {
  voucher: Voucher;
  signature: Hex;
  /**
   * Actual signer. `undefined` / zero address means "the payer itself".
   * Set when a delegated session key signed the voucher.
   */
  signer?: Address;
}

/** Chain / token configuration a channel lives on. */
export interface PaymentNetwork {
  chainId: number;
  /** Address of the L402Escrow contract. */
  escrow: Address;
  /** ERC-20 token used for payments (e.g. cbBTC on Base). */
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
}

/**
 * Payment request returned in the 402 challenge. It is the EVM equivalent of
 * the Lightning invoice: it tells the client exactly what to sign.
 */
export interface PaymentRequest extends PaymentNetwork {
  scheme: "l402-el2";
  version: typeof L402_EL2_VERSION;
  /** Address of the MCP server that will collect the payment. */
  provider: Address;
  /** Price of this single call, in token base units. */
  amount: string;
  /**
   * Minimum cumulative amount the next voucher must carry.
   * Present only when the server knows the payer (`X-L402-Payer` header).
   */
  cumulativeAmount?: string;
  /** Channel to sign for, when known. */
  channelId?: Hex;
  /** Next expected nonce, when known. */
  nonce?: number;
  /** Suggested voucher expiry (unix seconds). */
  validUntil: number;
  /** Suggested minimum deposit to open the channel. */
  minDeposit?: string;
  /** Human-readable description of what is being paid for. */
  description?: string;
  /**
   * Latest voucher the server accepted on this channel, when known. A client
   * that lost its local state (e.g. after a restart) can verify the signature
   * and re-synchronize instead of refusing to pay. Only vouchers that are
   * provably settleable on-chain should be adopted.
   */
  lastVoucher?: SerializedSignedVoucher;
}

/** Operators a first-party caveat can use. Longer operators first (parsing order). */
export const CAVEAT_OPERATORS = ["<=", ">=", "!=", "=", "<", ">", "in"] as const;
export type CaveatOp = (typeof CAVEAT_OPERATORS)[number];

/** First-party caveat of a macaroon: `key operator value`. */
export interface Caveat {
  key: string;
  op: CaveatOp;
  value: string;
}

export interface MacaroonIdentifier {
  /** Macaroon format version. */
  v: number;
  /** Service identifier (e.g. "mcp.example.com"). */
  service: string;
  /** Unique token id, used for revocation. */
  tokenId: string;
  /** Channel the macaroon is bound to, when already known. */
  channelId?: Hex;
}

export interface Macaroon {
  identifier: MacaroonIdentifier;
  caveats: Caveat[];
  /** Chained HMAC signature (hex, no 0x prefix). */
  signature: string;
}

/** Full credentials extracted from `Authorization: L402 <macaroon>:<proof>`. */
export interface L402Credentials {
  macaroon: Macaroon;
  macaroonRaw: string;
  proof: PaymentProof;
}

export type PaymentProof =
  | ({ type: "voucher" } & SerializedSignedVoucher)
  | { type: "tx"; txHash: Hex; payer: Address };

/** JSON-friendly form of a SignedVoucher (bigints as decimal strings / numbers). */
export interface SerializedSignedVoucher {
  channelId: Hex;
  cumulativeAmount: string;
  nonce: number;
  validUntil: number;
  signature: Hex;
  signer?: Address;
}

/** Outcome of the server-side verification. */
export interface VerificationResult {
  ok: boolean;
  payer?: Address;
  channelId?: Hex;
  /** Amount actually collectable on top of the previous voucher. */
  delta?: bigint;
  cumulativeAmount?: bigint;
  reason?: string;
  code?: L402ErrorCode;
}

export type L402ErrorCode =
  | "missing_credentials"
  | "malformed_credentials"
  | "invalid_macaroon"
  | "caveat_failed"
  | "macaroon_expired"
  | "revoked"
  | "invalid_proof"
  | "invalid_signature"
  | "voucher_expired"
  | "voucher_not_monotonic"
  | "insufficient_payment"
  | "insufficient_deposit"
  | "channel_not_found"
  | "channel_closing"
  | "delegation_invalid"
  | "rate_limited";

/**
 * Mirror of `L402Escrow.CLOSE_CHALLENGE_PERIOD` (seconds): how long after a close
 * request (or a session key revocation) vouchers remain settleable.
 */
export const CLOSE_CHALLENGE_PERIOD = 24n * 60n * 60n;
