import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { MemoryVoucherStore, RedisVoucherStore, type RedisLike, type StoredVoucher, type VoucherStore } from "./store/index.js";

/**
 * Behavioural contract shared by every VoucherStore implementation.
 * The Redis suite runs only when REDIS_URL points to a reachable server, e.g.
 *   REDIS_URL=redis://127.0.0.1:6379 npx vitest run
 */

const CHANNEL = `0x${"ab".repeat(32)}` as Hex;

function voucher(cumulativeAmount: bigint, channelId: Hex = CHANNEL): StoredVoucher {
  return {
    channelId,
    payer: "0x1111111111111111111111111111111111111111",
    cumulativeAmount: cumulativeAmount.toString(),
    nonce: Number(cumulativeAmount),
    validUntil: 2_000_000_000,
    signature: "0x00",
    updatedAt: Date.now(),
  };
}

function storeContract(name: string, makeStore: () => Promise<VoucherStore>) {
  describe(name, () => {
    let store: VoucherStore;
    beforeAll(async () => {
      store = await makeStore();
    });

    it("accepts only strictly increasing vouchers above the minimum", async () => {
      expect((await store.advance(voucher(100n), 100n)).ok).toBe(true);
      expect((await store.advance(voucher(100n), 100n)).ok).toBe(false); // replay
      expect((await store.advance(voucher(150n), 200n)).ok).toBe(false); // below minimum
      expect((await store.advance(voucher(200n), 200n)).ok).toBe(true);
      expect((await store.get(CHANNEL))?.cumulativeAmount).toBe("200");
    });

    it("compares uint256-sized amounts numerically, not as text", async () => {
      const channel = `0x${"cd".repeat(32)}` as Hex;
      expect((await store.advance(voucher(9n * 10n ** 19n, channel), 0n)).ok).toBe(true);
      expect((await store.advance(voucher(10n ** 20n, channel), 0n)).ok).toBe(true);
      expect((await store.advance(voucher(99n * 10n ** 18n, channel), 0n)).ok).toBe(false);
    });

    it("lets exactly one of N concurrent identical vouchers through", async () => {
      const channel = `0x${"ef".repeat(32)}` as Hex;
      const results = await Promise.all(Array.from({ length: 10 }, () => store.advance(voucher(500n, channel), 500n)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });

    it("keeps a channel pending when a newer voucher arrives after the settled one", async () => {
      const channel = `0x${"12".repeat(32)}` as Hex;
      await store.advance(voucher(1_000n, channel), 0n);
      await store.advance(voucher(1_100n, channel), 0n); // accepted while the settler was busy
      await store.markSettled(channel, 1_000n);

      const pending = await store.listPending();
      expect(pending.find((v) => v.channelId === channel)?.cumulativeAmount).toBe("1100");
      expect(await store.getSettled(channel)).toBe(1_000n);

      await store.markSettled(channel, 1_100n);
      expect((await store.listPending()).some((v) => v.channelId === channel)).toBe(false);
    });

    it("never lowers the settled amount", async () => {
      const channel = `0x${"34".repeat(32)}` as Hex;
      await store.markSettled(channel, 700n);
      await store.markSettled(channel, 300n);
      expect(await store.getSettled(channel)).toBe(700n);
    });

    it("revokes macaroons", async () => {
      await store.revoke("token-1", 60);
      expect(await store.isRevoked("token-1")).toBe(true);
      expect(await store.isRevoked("token-2")).toBe(false);
    });
  });
}

storeContract("MemoryVoucherStore", async () => new MemoryVoucherStore());

const redisUrl = process.env.REDIS_URL;
if (redisUrl) {
  let client: RedisLike & { flushdb(): Promise<unknown>; quit(): Promise<unknown> };
  beforeAll(async () => {
    const { Redis } = await import("ioredis");
    client = new Redis(redisUrl) as unknown as typeof client;
  });
  afterAll(async () => {
    await client?.quit();
  });
  storeContract("RedisVoucherStore", async () => {
    await client.flushdb();
    return new RedisVoucherStore(client, `test-${Date.now()}`);
  });
} else {
  describe.skip("RedisVoucherStore (set REDIS_URL to run)", () => {
    it("skipped", () => {});
  });
}
