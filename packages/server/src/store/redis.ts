import type { Hex } from "viem";
import type { AdvanceResult, StoredVoucher, VoucherStore } from "./index.js";

/**
 * Subset of the ioredis API actually used: avoids a hard dependency and accepts
 * any compatible client.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  quit?(): Promise<unknown>;
}

/*
 * Amounts are uint256 values. Lua numbers are 64-bit doubles and would lose
 * precision, so the scripts compare amounts as decimal strings left-padded to a
 * fixed width: for equal-length digit strings, lexicographic order == numeric order.
 */
const PAD = 78; // uint256 max has 78 decimal digits

function pad(value: bigint): string {
  return value.toString().padStart(PAD, "0");
}

/**
 * Accepts a voucher atomically: reads the current one, applies the monotonicity
 * rule and writes only if the new voucher is strictly greater. Without this, two
 * concurrent requests could both read the same "latest voucher" and get two
 * calls through for the price of one.
 *
 * KEYS: voucherKey, pendingSetKey
 * ARGV: payload, paddedIncoming, paddedMinCumulative, channelId
 */
const ADVANCE_SCRIPT = `
local voucherKey = KEYS[1]
local pendingKey = KEYS[2]
local payload = ARGV[1]
local incoming = ARGV[2]
local minCumulative = ARGV[3]
local channelId = ARGV[4]

if incoming < minCumulative then
  return { 0, redis.call('GET', voucherKey) or '', 'not_monotonic' }
end

local currentRaw = redis.call('GET', voucherKey)
if currentRaw then
  local current = cjson.decode(currentRaw)
  if incoming <= current.padded then
    return { 0, currentRaw, 'not_monotonic' }
  end
end

redis.call('SET', voucherKey, payload)
redis.call('SADD', pendingKey, channelId)
return { 1, payload, '' }
`;

/**
 * Records a settlement atomically: raises the settled amount (never lowers it)
 * and removes the channel from the pending set only if the stored voucher is
 * fully settled. Doing this in several round trips could drop a channel from the
 * pending set right after a newer voucher was accepted, and that voucher would
 * then never be settled.
 *
 * KEYS: settledKey, voucherKey, pendingSetKey
 * ARGV: paddedSettled, channelId
 */
const MARK_SETTLED_SCRIPT = `
local settledKey = KEYS[1]
local voucherKey = KEYS[2]
local pendingKey = KEYS[3]
local settled = ARGV[1]
local channelId = ARGV[2]

local previous = redis.call('GET', settledKey)
if previous then
  -- values written by older versions were not padded
  previous = string.rep('0', ${PAD} - #previous) .. previous
end
if (not previous) or settled > previous then
  redis.call('SET', settledKey, settled)
else
  settled = previous
end

local currentRaw = redis.call('GET', voucherKey)
if (not currentRaw) or cjson.decode(currentRaw).padded <= settled then
  redis.call('SREM', pendingKey, channelId)
end
return 1
`;

interface Envelope extends StoredVoucher {
  /** Padded cumulative amount: enables comparisons inside Lua. */
  padded: string;
}

function unwrap(raw: string): StoredVoucher {
  const { padded: _padded, ...voucher } = JSON.parse(raw) as Envelope;
  return voucher;
}

export class RedisVoucherStore implements VoucherStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = "l402",
  ) {}

  private voucherKey(channelId: Hex): string {
    return `${this.prefix}:voucher:${channelId.toLowerCase()}`;
  }

  private settledKey(channelId: Hex): string {
    return `${this.prefix}:settled:${channelId.toLowerCase()}`;
  }

  private get pendingKey(): string {
    return `${this.prefix}:pending`;
  }

  private revokedKey(tokenId: string): string {
    return `${this.prefix}:revoked:${tokenId}`;
  }

  async get(channelId: Hex): Promise<StoredVoucher | undefined> {
    const raw = await this.redis.get(this.voucherKey(channelId));
    return raw ? unwrap(raw) : undefined;
  }

  async advance(voucher: StoredVoucher, minCumulative: bigint): Promise<AdvanceResult> {
    const incoming = BigInt(voucher.cumulativeAmount);
    const envelope: Envelope = { ...voucher, padded: pad(incoming) };

    const [ok, currentRaw, reason] = (await this.redis.eval(
      ADVANCE_SCRIPT,
      2,
      this.voucherKey(voucher.channelId),
      this.pendingKey,
      JSON.stringify(envelope),
      pad(incoming),
      pad(minCumulative),
      voucher.channelId.toLowerCase(),
    )) as [number, string, string];

    const current = currentRaw ? unwrap(currentRaw) : undefined;
    return ok === 1
      ? { ok: true, current }
      : { ok: false, current, reason: (reason || "not_monotonic") as AdvanceResult["reason"] };
  }

  async listPending(limit = 1000): Promise<StoredVoucher[]> {
    const channelIds = await this.redis.smembers(this.pendingKey);
    const pending: StoredVoucher[] = [];
    for (const channelId of channelIds) {
      if (pending.length >= limit) break;
      const voucher = await this.get(channelId as Hex);
      if (!voucher) continue;
      const settled = await this.getSettled(channelId as Hex);
      if (BigInt(voucher.cumulativeAmount) > settled) pending.push(voucher);
    }
    return pending;
  }

  async markSettled(channelId: Hex, settledCumulative: bigint): Promise<void> {
    await this.redis.eval(
      MARK_SETTLED_SCRIPT,
      3,
      this.settledKey(channelId),
      this.voucherKey(channelId),
      this.pendingKey,
      pad(settledCumulative),
      channelId.toLowerCase(),
    );
  }

  async getSettled(channelId: Hex): Promise<bigint> {
    const raw = await this.redis.get(this.settledKey(channelId));
    return raw ? BigInt(raw) : 0n;
  }

  async revoke(tokenId: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.revokedKey(tokenId), "1", "EX", Math.max(1, Math.ceil(ttlSeconds)));
  }

  async isRevoked(tokenId: string): Promise<boolean> {
    return (await this.redis.exists(this.revokedKey(tokenId))) === 1;
  }

  async close(): Promise<void> {
    await this.redis.quit?.();
  }
}
