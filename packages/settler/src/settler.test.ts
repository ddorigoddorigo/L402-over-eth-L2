import { beforeAll, describe, expect, it } from "vitest";
import { getAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { computeChannelId, voucherTypedData, type Voucher } from "@l402-el2/core";
import { MemoryVoucherStore } from "@l402-el2/server";

import { startEvm, type TestEvm } from "../../contracts/tools/evm.mjs";
import { Settler } from "./settler.js";

const DAY = 86_400n;
const DEPOSIT = 1_000_000n;

interface Ctx {
  evm: TestEvm;
  publicClient: PublicClient;
  escrow: { address: Address; abi: unknown };
  token: { address: Address; abi: unknown };
  provider: Address;
  send(index: number, contract: { address: Address; abi: unknown }, functionName: string, args: unknown[]): Promise<void>;
  openChannel(payerIndex: number, duration: bigint): Promise<Hex>;
  signedVoucher(payerIndex: number, channelId: Hex, cumulativeAmount: bigint): Promise<{ voucher: Voucher; signature: Hex }>;
  balanceOf(address: Address): Promise<bigint>;
}

let ctx: Ctx;

beforeAll(async () => {
  const evm = await startEvm();
  const publicClient = evm.publicClient as PublicClient;
  const [deployer, providerAccount] = evm.accounts;
  const token = await evm.deploy("MockBTC");
  const escrow = await evm.deploy("L402Escrow", [deployer!.address, deployer!.address, 0]);

  const send: Ctx["send"] = async (index, contract, functionName, args) => {
    const hash = await evm.wallets[index]!.writeContract({
      address: contract.address,
      abi: contract.abi as never,
      functionName,
      args: args as never,
      account: evm.accounts[index]!,
      chain: evm.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  };

  ctx = {
    evm,
    publicClient,
    escrow,
    token,
    provider: getAddress(providerAccount!.address),
    send,
    async openChannel(payerIndex, duration) {
      const payer = evm.accounts[payerIndex]!;
      await send(0, token, "mint", [payer.address, DEPOSIT]);
      await send(payerIndex, token, "approve", [escrow.address, DEPOSIT]);
      await send(payerIndex, escrow, "openChannel", [providerAccount!.address, token.address, DEPOSIT, duration]);
      return computeChannelId(getAddress(payer.address), getAddress(providerAccount!.address), token.address);
    },
    async signedVoucher(payerIndex, channelId, cumulativeAmount) {
      const voucher: Voucher = {
        channelId,
        cumulativeAmount,
        nonce: cumulativeAmount,
        validUntil: BigInt(Math.floor(Date.now() / 1000)) + 10n * DAY,
      };
      const signature = await evm.accounts[payerIndex]!.signTypedData(
        voucherTypedData(evm.chain.id, escrow.address, voucher),
      );
      return { voucher, signature };
    },
    async balanceOf(address) {
      return (await publicClient.readContract({
        address: token.address,
        abi: token.abi as never,
        functionName: "balanceOf",
        args: [address] as never,
      })) as bigint;
    },
  };
}, 60_000);

function settlerFor(store: MemoryVoucherStore, minSettleAmount = 1n, expiryBuffer = 2 * 3600) {
  return new Settler(settlerConfig(store, minSettleAmount, expiryBuffer));
}

function settlerConfig(store: MemoryVoucherStore, minSettleAmount = 1n, expiryBuffer = 2 * 3600) {
  const providerAccount = ctx.evm.accounts[1]!;
  return {
    store,
    publicClient: ctx.publicClient,
    walletClient: ctx.evm.wallets[1]!,
    account: providerAccount,
    escrow: ctx.escrow.address,
    tokenDecimals: 8,
    tokenSymbol: "cbBTC",
    minSettleAmount,
    expiryBuffer,
  };
}

async function remember(store: MemoryVoucherStore, payerIndex: number, voucher: Voucher, signature: Hex) {
  await store.advance(
    {
      channelId: voucher.channelId,
      payer: getAddress(ctx.evm.accounts[payerIndex]!.address),
      cumulativeAmount: voucher.cumulativeAmount.toString(),
      nonce: Number(voucher.nonce),
      validUntil: Number(voucher.validUntil),
      signature,
      updatedAt: Date.now(),
    },
    0n,
  );
}

describe("Settler", () => {
  it("drops a voucher that would revert instead of blocking the whole batch", async () => {
    const store = new MemoryVoucherStore();
    const good = await ctx.openChannel(2, 30n * DAY);
    const bad = await ctx.openChannel(3, 30n * DAY);

    const goodVoucher = await ctx.signedVoucher(2, good, 1_000n);
    await remember(store, 2, goodVoucher.voucher, goodVoucher.signature);

    // Signed by the wrong account: settleBatch would revert with InvalidSignature.
    const forged = await ctx.signedVoucher(4, bad, 2_000n);
    await remember(store, 3, forged.voucher, forged.signature);

    const before = await ctx.balanceOf(ctx.provider);
    const result = await settlerFor(store).settle();

    expect(result?.settled).toBe(1);
    expect(result?.dropped.map((d) => d.channelId)).toEqual([bad]);
    expect((await ctx.balanceOf(ctx.provider)) - before).toBe(1_000n);
    expect(await store.getSettled(good)).toBe(1_000n);
    expect(await store.getSettled(bad)).toBe(0n);
  });

  it("settles small amounts early when the channel is about to expire", async () => {
    const store = new MemoryVoucherStore();
    const shortLived = await ctx.openChannel(5, 3_600n); // expires in 1 hour
    const longLived = await ctx.openChannel(6, 30n * DAY);

    for (const [payerIndex, channelId] of [
      [5, shortLived],
      [6, longLived],
    ] as const) {
      const { voucher, signature } = await ctx.signedVoucher(payerIndex, channelId, 50n);
      await remember(store, payerIndex, voucher, signature);
    }

    // Both amounts are below the threshold: only the expiring channel is urgent.
    const plan = await settlerFor(store, 10_000n).plan();
    expect(plan.items.map((item) => item.voucher.channelId)).toEqual([shortLived]);
    expect(plan.items[0]!.urgent).toBe(true);
    expect(plan.skipped.find((s) => s.channelId === longLived)?.reason).toBe("below_threshold");
  });

  it("forgets vouchers that are already settled on-chain", async () => {
    const store = new MemoryVoucherStore();
    const channelId = await ctx.openChannel(7, 30n * DAY);
    const { voucher, signature } = await ctx.signedVoucher(7, channelId, 3_000n);
    await ctx.send(1, ctx.escrow, "settle", [voucher, signature, zeroAddress]); // settled by someone else
    await remember(store, 7, voucher, signature);

    const plan = await settlerFor(store).plan();
    expect(plan.items).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("already_settled_or_void");
    expect(await store.listPending()).toHaveLength(0);
  });

  it("does not starve channels beyond the first page of pending vouchers", async () => {
    const store = new MemoryVoucherStore();
    const small = await ctx.openChannel(8, 30n * DAY);
    const big = await ctx.openChannel(9, 30n * DAY);
    for (const [payerIndex, channelId, amount] of [
      [8, small, 10n], // below threshold, listed first
      [9, big, 50_000n],
    ] as const) {
      const { voucher, signature } = await ctx.signedVoucher(payerIndex, channelId, amount);
      await remember(store, payerIndex, voucher, signature);
    }
    // With a fixed page (the old behaviour, here a page of one) the big channel is never seen...
    const starved = await new Settler({ ...settlerConfig(store, 10_000n), maxScan: 1 }).plan();
    expect(starved.items).toHaveLength(0);
    // ...while the default scans every pending channel.
    const plan = await settlerFor(store, 10_000n).plan();
    expect(plan.items.map((item) => item.voucher.channelId)).toEqual([big]);
  });
});
