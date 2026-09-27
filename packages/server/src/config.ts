import type { Address, PublicClient } from "viem";
import type { VoucherStore } from "./store/index.js";

/** Price of a resource, in token base units (satoshis for cbBTC). */
export type Price = bigint;

export interface PricingPolicy {
  /** Price of any resource not listed below. `0n` = free. */
  default: Price;
  /** Price per MCP tool name or HTTP path. */
  resources?: Record<string, Price>;
}

export interface GatekeeperConfig {
  /** Service name; it ends up in the macaroon identifier. */
  service: string;
  /**
   * HMAC key for macaroons (at least 32 bytes). Rotating it invalidates every
   * macaroon issued so far: keep it in a secret manager, not in the code.
   */
  rootKey: Buffer;
  /** Address that collects the vouchers (the MCP server's wallet). */
  provider: Address;
  chainId: number;
  escrow: Address;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Read-only RPC client on the L2. */
  publicClient: PublicClient;
  /** Where the latest vouchers are stored. */
  store: VoucherStore;
  pricing: PricingPolicy;

  /** Lifetime of the macaroon issued in the challenge (seconds). Default 3600. */
  macaroonTtl?: number;
  /**
   * Suggested voucher lifetime put in the payment request (seconds). Default 86400.
   * Must be larger than `minVoucherTimeLeft`.
   */
  voucherTtl?: number;
  /**
   * Minimum remaining lifetime a voucher must have to be accepted (seconds).
   * The provider can only settle a voucher before its `validUntil`, so accepting
   * a voucher that expires in a few seconds means working for free. Keep it
   * larger than the settler interval plus its `expiryBuffer`. Default 7200.
   */
  minVoucherTimeLeft?: number;
  /**
   * Cumulative cap granted by a single macaroon, on top of the current amount.
   * Limits the damage if the macaroon leaks. Default: 1000x the highest price.
   */
  macaroonMaxCumulative?: bigint;
  /** Suggested minimum deposit sent to the client. Default: 1000x the highest price. */
  minDeposit?: bigint;
  /** TTL of the on-chain read cache (ms). Default 15000. */
  chainCacheTtlMs?: number;
  /**
   * Minimum remaining lifetime of the channel (and of the session key, when one
   * is used) for the server to accept vouchers (seconds). Below this threshold
   * the provider risks not settling in time. Default 7200 (2 hours).
   */
  minChannelTimeLeft?: number;
}

export interface ResolvedConfig extends Required<Omit<GatekeeperConfig, "pricing">> {
  pricing: PricingPolicy;
}

/** Highest price in the pricing policy: used to derive sensible defaults. */
export function highestPrice(pricing: PricingPolicy): Price {
  return Object.values(pricing.resources ?? {}).reduce((max, price) => (price > max ? price : max), pricing.default);
}

export function resolveConfig(config: GatekeeperConfig): ResolvedConfig {
  if (config.rootKey.length < 32) {
    throw new Error("rootKey must be at least 32 bytes long");
  }
  const referencePrice = highestPrice(config.pricing);
  const resolved: ResolvedConfig = {
    ...config,
    macaroonTtl: config.macaroonTtl ?? 3600,
    voucherTtl: config.voucherTtl ?? 86_400,
    minVoucherTimeLeft: config.minVoucherTimeLeft ?? 7200,
    macaroonMaxCumulative: config.macaroonMaxCumulative ?? referencePrice * 1000n,
    minDeposit: config.minDeposit ?? referencePrice * 1000n,
    chainCacheTtlMs: config.chainCacheTtlMs ?? 15_000,
    minChannelTimeLeft: config.minChannelTimeLeft ?? 7200,
  };
  if (resolved.voucherTtl <= resolved.minVoucherTimeLeft) {
    throw new Error(
      `voucherTtl (${resolved.voucherTtl}s) must be larger than minVoucherTimeLeft (${resolved.minVoucherTimeLeft}s), ` +
        "otherwise the vouchers the server asks for would be rejected by the server itself",
    );
  }
  return resolved;
}

export function priceFor(pricing: PricingPolicy, resource: string): Price {
  return pricing.resources?.[resource] ?? pricing.default;
}
