import type { Address, Hex, PublicClient } from "viem";
import { escrowAbi } from "@l402-el2/core";

export interface ChannelState {
  payer: Address;
  provider: Address;
  token: Address;
  deposited: bigint;
  claimed: bigint;
  refunded: bigint;
  expiry: bigint;
  closeRequestedAt: bigint;
  exists: boolean;
  /** deposited - claimed - refunded */
  available: bigint;
  /**
   * claimed + refunded: where the channel's cumulative counter stands on-chain.
   * A voucher is only settleable if its cumulative amount is above this value.
   */
  cumulativeFloor: bigint;
}

export interface DelegationState {
  maxCumulative: bigint;
  validUntil: bigint;
  active: boolean;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * On-chain reads with a short TTL cache.
 *
 * The hot path of an MCP call must stay under ~10 ms: the RPC cannot be queried
 * on every request. The cache is deliberately optimistic — the risk is accepting
 * a voucher a few seconds after the payer changed something on-chain. Every
 * payer action that can hurt the provider (closing, revoking a session key) only
 * takes effect after the contract's 24-hour grace period, which dwarfs the TTL.
 */
export class ChainReader {
  private readonly channels = new Map<string, CacheEntry<ChannelState>>();
  private readonly delegations = new Map<string, CacheEntry<DelegationState>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  /**
   * @param maxEntries Upper bound of each cache. Channel ids come from request
   *   headers, so an unbounded cache would let anyone grow the server's memory.
   */
  constructor(
    private readonly client: PublicClient,
    private readonly escrow: Address,
    private readonly ttlMs = 15_000,
    private readonly maxEntries = 10_000,
  ) {}

  /**
   * Last known state of a channel WITHOUT any RPC call, even if the cache entry
   * is stale. Safe for lower bounds such as `cumulativeFloor`, which only grows.
   */
  peekChannel(channelId: Hex): ChannelState | undefined {
    return this.channels.get(channelId.toLowerCase())?.value;
  }

  async getChannel(channelId: Hex, { fresh = false } = {}): Promise<ChannelState> {
    const key = channelId.toLowerCase();
    if (!fresh) {
      const cached = this.channels.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
    }
    return this.dedupe(`channel:${key}:${fresh}`, async () => {
      const raw = (await this.client.readContract({
        address: this.escrow,
        abi: escrowAbi,
        functionName: "getChannel",
        args: [channelId],
      })) as Omit<ChannelState, "available" | "cumulativeFloor">;
      const state: ChannelState = {
        ...raw,
        available: raw.deposited - raw.claimed - raw.refunded,
        cumulativeFloor: raw.claimed + raw.refunded,
      };
      this.remember(this.channels, key, state);
      return state;
    });
  }

  async getDelegation(payer: Address, signer: Address, { fresh = false } = {}): Promise<DelegationState> {
    const key = `${payer.toLowerCase()}:${signer.toLowerCase()}`;
    if (!fresh) {
      const cached = this.delegations.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
    }
    return this.dedupe(`delegation:${key}:${fresh}`, async () => {
      const [maxCumulative, validUntil, active] = (await this.client.readContract({
        address: this.escrow,
        abi: escrowAbi,
        functionName: "delegations",
        args: [payer, signer],
      })) as readonly [bigint, bigint, boolean];
      const state: DelegationState = { maxCumulative, validUntil, active };
      this.remember(this.delegations, key, state);
      return state;
    });
  }

  /** Drops the cached state of a channel (e.g. after a settlement). */
  invalidate(channelId: Hex): void {
    this.channels.delete(channelId.toLowerCase());
  }

  /** Stores an entry, evicting the oldest ones beyond `maxEntries` (Map keeps insertion order). */
  private remember<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    cache.delete(key); // re-insert so that refreshed keys become the newest
    cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (cache.size > this.maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  /** Avoids firing N identical RPC calls in parallel under load. */
  private async dedupe<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = load().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}
