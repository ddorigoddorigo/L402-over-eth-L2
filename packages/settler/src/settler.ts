import {
  getAddress,
  zeroAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { CLOSE_CHALLENGE_PERIOD, escrowAbi, formatUnits } from "@l402-el2/core";
import type { StoredVoucher, VoucherStore } from "@l402-el2/server";

export interface SettlerConfig {
  store: VoucherStore;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** The provider's account: only the provider can settle its own channels. */
  account: Account;
  escrow: Address;
  tokenDecimals: number;
  tokenSymbol: string;
  /**
   * Settle a channel only when the pending amount reaches this threshold. Avoids
   * burning more gas than the amount being collected.
   */
  minSettleAmount: bigint;
  /** Vouchers per batch transaction. Default 50. */
  batchSize?: number;
  /**
   * Safety margin (seconds): a voucher whose settlement deadline (voucher expiry,
   * channel expiry, end of a close challenge period or session key expiry) falls
   * within this window is settled right away, regardless of `minSettleAmount`.
   * Keep it larger than the interval between two settler runs (with the default
   * one-hour interval, 5400 guarantees at least 30 minutes of slack), and smaller
   * than the server's `minVoucherTimeLeft` / `minChannelTimeLeft` (7200). Default 5400.
   */
  expiryBuffer?: number;
  /** Maximum number of parallel RPC reads while planning. Default 10. */
  readConcurrency?: number;
  /**
   * How many pending channels to examine per run. Default: all of them. A low
   * cap can starve channels: if the first N are all below the threshold, the
   * others (maybe urgent) would never be looked at.
   */
  maxScan?: number;
  /** Logging callback. */
  onSettle?: (info: { txHash: Hex; channels: number; total: bigint }) => void;
}

export type SkipReason =
  | "below_threshold"
  | "already_settled_or_void"
  | "channel_not_found"
  | "deadline_passed"
  | "read_failed"
  | "simulation_failed";

export interface PlannedSettlement {
  voucher: StoredVoucher;
  /** Amount this settlement would transfer (cumulative minus on-chain floor). */
  amount: bigint;
  /** Unix time after which the voucher can no longer be settled. */
  deadline: number;
  urgent: boolean;
}

export interface SettlementPlan {
  items: PlannedSettlement[];
  /** Same vouchers as `items`, kept for convenience. */
  vouchers: StoredVoucher[];
  total: bigint;
  skipped: { channelId: Hex; reason: SkipReason; pending: bigint; detail?: string }[];
}

export interface SettlementResult {
  txHash: Hex;
  settled: number;
  total: bigint;
  /** Vouchers dropped from the batch because their simulation failed. */
  dropped: SettlementPlan["skipped"];
}

interface OnChainChannel {
  deposited: bigint;
  claimed: bigint;
  refunded: bigint;
  expiry: bigint;
  closeRequestedAt: bigint;
  exists: boolean;
}

/** Runs `task` over `items` with at most `limit` promises in flight. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function firstLine(error: unknown): string {
  return ((error as Error)?.message ?? String(error)).split("\n")[0] ?? "error";
}

/**
 * Settlement service.
 *
 * This is where thousands of off-chain micro-payments become a handful of L2
 * transactions. The rule: settle when it is worth it (pending amount above the
 * threshold) or when you must (the voucher, the channel or the session key is
 * about to stop being settleable).
 */
export class Settler {
  private readonly config: Required<Omit<SettlerConfig, "onSettle">> & Pick<SettlerConfig, "onSettle">;

  constructor(config: SettlerConfig) {
    this.config = {
      ...config,
      batchSize: config.batchSize ?? 50,
      expiryBuffer: config.expiryBuffer ?? 5400,
      readConcurrency: config.readConcurrency ?? 10,
      maxScan: config.maxScan ?? Number.MAX_SAFE_INTEGER,
    };
  }

  /* --------------------------------- PLAN ---------------------------------- */

  /** Decides what to settle, without sending anything. */
  async plan(): Promise<SettlementPlan> {
    const now = Math.floor(Date.now() / 1000);
    const pending = await this.config.store.listPending(this.config.maxScan);

    // One failed read must not abort the whole run: that voucher is retried next time.
    const evaluated = await mapWithConcurrency(pending, this.config.readConcurrency, (voucher) =>
      this.evaluate(voucher, now).catch((error: unknown) => ({
        skip: {
          channelId: voucher.channelId,
          reason: "read_failed" as const,
          pending: BigInt(voucher.cumulativeAmount),
          detail: firstLine(error),
        },
      })),
    );

    const items: PlannedSettlement[] = [];
    const skipped: SettlementPlan["skipped"] = [];
    for (const outcome of evaluated) {
      if ("skip" in outcome) skipped.push(outcome.skip);
      else items.push(outcome.item);
    }

    // Most urgent first, so the closest deadlines always make it into the batch.
    items.sort((a, b) => a.deadline - b.deadline);
    const selected = items.slice(0, this.config.batchSize);
    return {
      items: selected,
      vouchers: selected.map((item) => item.voucher),
      total: selected.reduce((sum, item) => sum + item.amount, 0n),
      skipped,
    };
  }

  private async evaluate(
    voucher: StoredVoucher,
    now: number,
  ): Promise<{ item: PlannedSettlement } | { skip: SettlementPlan["skipped"][number] }> {
    const cumulative = BigInt(voucher.cumulativeAmount);
    const channel = await this.readChannel(voucher.channelId);
    const skip = (reason: SkipReason, pendingAmount: bigint, detail?: string) => ({
      skip: { channelId: voucher.channelId, reason, pending: pendingAmount, ...(detail ? { detail } : {}) },
    });

    if (!channel.exists) return skip("channel_not_found", cumulative);

    // Everything at or below the on-chain floor was already settled or refunded.
    const onChainFloor = channel.claimed + channel.refunded;
    if (cumulative <= onChainFloor) {
      await this.config.store.markSettled(voucher.channelId, cumulative);
      return skip("already_settled_or_void", 0n);
    }
    const amount = cumulative - onChainFloor;

    const deadline = await this.deadlineOf(voucher, channel);
    if (deadline <= now) return skip("deadline_passed", amount);

    const urgent = deadline - now <= this.config.expiryBuffer;
    if (amount < this.config.minSettleAmount && !urgent) return skip("below_threshold", amount);

    return { item: { voucher, amount, deadline, urgent } };
  }

  /**
   * Last moment the voucher can be settled: the earliest among the voucher's own
   * expiry, the channel expiry (the payer can withdraw right after it), the end of
   * the challenge period of a close request and the session key expiry.
   */
  private async deadlineOf(voucher: StoredVoucher, channel: OnChainChannel): Promise<number> {
    const deadlines = [BigInt(voucher.validUntil), channel.expiry];
    if (channel.closeRequestedAt !== 0n) deadlines.push(channel.closeRequestedAt + CLOSE_CHALLENGE_PERIOD);
    if (voucher.signer && getAddress(voucher.signer) !== getAddress(voucher.payer)) {
      const [, validUntil] = (await this.config.publicClient.readContract({
        address: this.config.escrow,
        abi: escrowAbi,
        functionName: "delegations",
        args: [voucher.payer, voucher.signer],
      })) as readonly [bigint, bigint, boolean];
      deadlines.push(validUntil);
    }
    return Number(deadlines.reduce((min, value) => (value < min ? value : min)));
  }

  private async readChannel(channelId: Hex): Promise<OnChainChannel> {
    return (await this.config.publicClient.readContract({
      address: this.config.escrow,
      abi: escrowAbi,
      functionName: "getChannel",
      args: [channelId],
    })) as OnChainChannel;
  }

  /* -------------------------------- EXECUTE -------------------------------- */

  /**
   * Executes the plan in a single `settleBatch` transaction.
   *
   * The batch is all-or-nothing on-chain, so it is simulated first. If the
   * simulation fails, each voucher is simulated on its own and the failing ones
   * (channel drained, key revoked, ...) are dropped, so one bad voucher can never
   * block every other settlement.
   */
  async settle(plan?: SettlementPlan): Promise<SettlementResult | undefined> {
    const target = plan ?? (await this.plan());
    let items = target.items;
    const dropped: SettlementPlan["skipped"] = [];
    if (items.length === 0) return undefined;

    let request;
    try {
      request = await this.simulateBatch(items);
    } catch {
      items = await this.keepSettleable(items, dropped);
      if (items.length === 0) return undefined;
      request = await this.simulateBatch(items);
    }

    const txHash = await this.config.walletClient.writeContract(request);
    const receipt = await this.config.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`settleBatch reverted on-chain (tx ${txHash}): nothing was marked as settled`);
    }

    for (const { voucher } of items) {
      await this.config.store.markSettled(voucher.channelId, BigInt(voucher.cumulativeAmount));
    }

    const total = items.reduce((sum, item) => sum + item.amount, 0n);
    this.config.onSettle?.({ txHash, channels: items.length, total });
    return { txHash, settled: items.length, total, dropped };
  }

  /**
   * Settles channels one transaction at a time. More expensive than `settle`,
   * but isolates vouchers that fail instead of aborting the whole batch.
   */
  async settleIndividually(): Promise<{ ok: number; failed: { channelId: Hex; error: string }[] }> {
    const { items } = await this.plan();
    const failed: { channelId: Hex; error: string }[] = [];
    let ok = 0;

    for (const { voucher } of items) {
      try {
        const { request } = await this.config.publicClient.simulateContract({
          address: this.config.escrow,
          abi: escrowAbi,
          functionName: "settle",
          args: this.settleArgs(voucher),
          account: this.config.account,
        });
        const hash = await this.config.walletClient.writeContract(request);
        const receipt = await this.config.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`settle reverted on-chain (tx ${hash})`);
        await this.config.store.markSettled(voucher.channelId, BigInt(voucher.cumulativeAmount));
        ok++;
      } catch (error) {
        failed.push({ channelId: voucher.channelId, error: firstLine(error) });
      }
    }
    return { ok, failed };
  }

  private settleArgs(voucher: StoredVoucher) {
    return [
      {
        channelId: voucher.channelId,
        cumulativeAmount: BigInt(voucher.cumulativeAmount),
        nonce: BigInt(voucher.nonce),
        validUntil: BigInt(voucher.validUntil),
      },
      voucher.signature,
      voucher.signer ? getAddress(voucher.signer) : zeroAddress,
    ] as const;
  }

  private async simulateBatch(items: PlannedSettlement[]) {
    const args = items.map(({ voucher }) => this.settleArgs(voucher));
    const { request } = await this.config.publicClient.simulateContract({
      address: this.config.escrow,
      abi: escrowAbi,
      functionName: "settleBatch",
      args: [args.map((a) => a[0]), args.map((a) => a[1]), args.map((a) => a[2])],
      account: this.config.account,
    });
    return request;
  }

  /** Simulates each voucher alone and keeps only those that would succeed. */
  private async keepSettleable(
    items: PlannedSettlement[],
    dropped: SettlementPlan["skipped"],
  ): Promise<PlannedSettlement[]> {
    const verdicts = await mapWithConcurrency(items, this.config.readConcurrency, async (item) => {
      try {
        await this.config.publicClient.simulateContract({
          address: this.config.escrow,
          abi: escrowAbi,
          functionName: "settle",
          args: this.settleArgs(item.voucher),
          account: this.config.account,
        });
        return undefined;
      } catch (error) {
        return firstLine(error);
      }
    });
    return items.filter((item, index) => {
      const error = verdicts[index];
      if (error === undefined) return true;
      dropped.push({ channelId: item.voucher.channelId, reason: "simulation_failed", pending: item.amount, detail: error });
      return false;
    });
  }

  /* -------------------------------- REPORTS -------------------------------- */

  /** Human-readable summary of the current plan. */
  async describe(): Promise<string> {
    const { items, total, skipped } = await this.plan();
    const format = (amount: bigint) => `${formatUnits(amount, this.config.tokenDecimals)} ${this.config.tokenSymbol}`;
    return [
      `To settle: ${items.length} channels for ${format(total)}`,
      ...items
        .filter((item) => item.urgent)
        .map((item) => `  urgent   ${item.voucher.channelId.slice(0, 10)}… deadline ${new Date(item.deadline * 1000).toISOString()}`),
      ...skipped.map((s) => `  skipped  ${s.channelId.slice(0, 10)}… (${s.reason}, ${format(s.pending)})`),
    ].join("\n");
  }
}

/**
 * Runs the settler at a fixed interval. Returns a stop function.
 * A run never overlaps the previous one: if a settlement takes longer than the
 * interval, the next tick is skipped instead of sending a duplicate transaction.
 */
export function startSettlerLoop(settler: Settler, intervalMs: number): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await settler.settle();
      if (result) {
        console.log(`[settler] settled ${result.settled} channels — tx ${result.txHash}`);
        for (const d of result.dropped) {
          console.warn(`[settler] dropped ${d.channelId.slice(0, 10)}…: ${d.detail ?? d.reason}`);
        }
      }
    } catch (error) {
      console.error("[settler] error:", firstLine(error));
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
