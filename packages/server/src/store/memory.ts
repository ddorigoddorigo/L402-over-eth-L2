import type { Hex } from "viem";
import type { AdvanceResult, StoredVoucher, VoucherStore } from "./index.js";

/**
 * In-memory store. Fine for development, tests and a single process.
 * In multi-instance production use RedisVoucherStore: here atomicity only
 * holds inside the current process, and everything is lost on restart.
 */
export class MemoryVoucherStore implements VoucherStore {
  private readonly vouchers = new Map<string, StoredVoucher>();
  private readonly settled = new Map<string, bigint>();
  private readonly revoked = new Map<string, number>();
  /** Promise chain per channelId: serializes concurrent `advance` calls. */
  private readonly locks = new Map<string, Promise<unknown>>();

  async get(channelId: Hex): Promise<StoredVoucher | undefined> {
    return this.vouchers.get(channelId.toLowerCase());
  }

  async advance(voucher: StoredVoucher, minCumulative: bigint): Promise<AdvanceResult> {
    return this.withLock(voucher.channelId, async () => {
      const key = voucher.channelId.toLowerCase();
      const current = this.vouchers.get(key);
      const incoming = BigInt(voucher.cumulativeAmount);
      const floor = current ? BigInt(current.cumulativeAmount) : 0n;

      if (incoming < minCumulative || incoming <= floor) {
        return { ok: false, current, reason: "not_monotonic" as const };
      }
      this.vouchers.set(key, voucher);
      return { ok: true, current: voucher };
    });
  }

  async listPending(limit = 1000): Promise<StoredVoucher[]> {
    const pending: StoredVoucher[] = [];
    for (const [key, voucher] of this.vouchers) {
      if (pending.length >= limit) break;
      const settled = this.settled.get(key) ?? 0n;
      if (BigInt(voucher.cumulativeAmount) > settled) pending.push(voucher);
    }
    return pending;
  }

  async markSettled(channelId: Hex, settledCumulative: bigint): Promise<void> {
    const key = channelId.toLowerCase();
    const current = this.settled.get(key) ?? 0n;
    if (settledCumulative > current) this.settled.set(key, settledCumulative);
  }

  async getSettled(channelId: Hex): Promise<bigint> {
    return this.settled.get(channelId.toLowerCase()) ?? 0n;
  }

  async revoke(tokenId: string, ttlSeconds: number): Promise<void> {
    this.revoked.set(tokenId, Date.now() + ttlSeconds * 1000);
  }

  async isRevoked(tokenId: string): Promise<boolean> {
    const expiry = this.revoked.get(tokenId);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) {
      this.revoked.delete(tokenId);
      return false;
    }
    return true;
  }

  private withLock<T>(channelId: Hex, task: () => Promise<T>): Promise<T> {
    const key = channelId.toLowerCase();
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    // The queue must never break because a previous task failed.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return result;
  }
}
