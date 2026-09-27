import type { Address, Hex } from "viem";

/** Latest voucher accepted for a channel: all the server needs to remember. */
export interface StoredVoucher {
  channelId: Hex;
  payer: Address;
  cumulativeAmount: string;
  nonce: number;
  validUntil: number;
  signature: Hex;
  signer?: Address;
  /** Acceptance timestamp (ms). */
  updatedAt: number;
}

export interface AdvanceResult {
  ok: boolean;
  /** Voucher that is current after the operation. */
  current: StoredVoucher | undefined;
  reason?: "not_monotonic" | "conflict";
}

/**
 * Storage for the latest vouchers.
 *
 * `advance` MUST be atomic per `channelId`: two concurrent requests from the same
 * agent must not both get the same cumulative amount accepted. Without
 * atomicity a malicious client could fire N requests in parallel and pay for one.
 */
export interface VoucherStore {
  /** Latest voucher accepted for the channel. */
  get(channelId: Hex): Promise<StoredVoucher | undefined>;

  /**
   * Accepts the voucher only if `cumulativeAmount >= minCumulative` and it is
   * strictly greater than the stored one. Atomic.
   */
  advance(voucher: StoredVoucher, minCumulative: bigint): Promise<AdvanceResult>;

  /** Lists vouchers with an unsettled amount (used by the settler). */
  listPending(limit?: number): Promise<StoredVoucher[]>;

  /** Records that the channel was settled on-chain up to `settledCumulative`. */
  markSettled(channelId: Hex, settledCumulative: bigint): Promise<void>;

  /** Cumulative amount already settled on-chain, to compute what is pending. */
  getSettled(channelId: Hex): Promise<bigint>;

  /** Revokes a macaroon by tokenId. */
  revoke(tokenId: string, ttlSeconds: number): Promise<void>;
  isRevoked(tokenId: string): Promise<boolean>;

  close?(): Promise<void>;
}

export { MemoryVoucherStore } from "./memory.js";
export { RedisVoucherStore, type RedisLike } from "./redis.js";
