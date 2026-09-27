import { getAddress, type Address } from "viem";
import {
  buildAuthorizationHeader,
  encodeMacaroon,
  formatUnits,
  macaroonExpiry,
  parseChallengeHeader,
  proofFromSignedVoucher,
  PAYER_HEADER,
  type Macaroon,
  type PaymentRequest,
  type SerializedSignedVoucher,
} from "@l402-el2/core";
import type { ChannelManager } from "./channel.js";

/** Spending limits enforced client-side, before anything is signed. */
export interface SpendingPolicy {
  /** Maximum amount a single call may add to the liability. */
  maxPricePerCall: bigint;
  /** Total budget for the whole agent session. */
  totalBudget: bigint;
  /** If set, pay only these providers. */
  allowedProviders?: Address[];
  /** If set, accept only these escrows (defence against fake challenges). */
  allowedEscrows?: Address[];
  /** Accepted chains. The ChannelManager's own chain is always required anyway. */
  allowedChainIds?: number[];
}

export class PaymentRefused extends Error {
  constructor(
    message: string,
    readonly paymentRequest?: PaymentRequest,
  ) {
    super(message);
    this.name = "PaymentRefused";
  }
}

export interface L402FetchOptions {
  channels: ChannelManager;
  policy: SpendingPolicy;
  /** Underlying `fetch`. Default: the global one. */
  fetch?: typeof globalThis.fetch;
  /**
   * Automatically top up the channel when the server reports an insufficient
   * deposit (or a missing / closing channel). If absent, the error reaches the agent.
   */
  autoTopUp?: { amount: bigint; maxTimes?: number };
  /** Observability callback for every payment made. `amount` is the real increment. */
  onPayment?: (info: { provider: Address; amount: bigint; cumulative: bigint; url: string }) => void;
}

/** What the client remembers about a paid resource after a successful call. */
interface CachedCredential {
  macaroon: Macaroon;
  provider: Address;
  price: bigint;
  escrow: Address;
  chainId: number;
  token: Address;
  /** Voucher lifetime the server asked for (seconds). */
  voucherTtl: number;
  /** When to stop using this macaroon (unix seconds, with a safety margin). */
  expiresAt: number;
}

interface PaymentTerms {
  provider: Address;
  escrow: Address;
  chainId: number;
  token: Address;
  price: bigint;
  /** Cumulative amount requested by the server, if it sent one. */
  cumulativeAmount?: bigint;
  /** Latest voucher the server accepted, used to re-synchronize after a restart. */
  lastVoucher?: SerializedSignedVoucher;
  validUntil: bigint;
  /** Original payment request, attached to errors for diagnostics. */
  source?: PaymentRequest;
}

/** Errors that go away by depositing more funds into the channel. */
const NEEDS_FUNDING = new Set(["insufficient_deposit", "channel_not_found", "channel_closing"]);
/**
 * Errors a new voucher cannot fix: signing anyway would only raise the agent's
 * liability (and eat its budget) for a call the server will refuse again.
 */
const UNPAYABLE = new Set([...NEEDS_FUNDING, "delegation_invalid"]);
/** Retries after the first 402/401 before giving up. */
const MAX_PAYMENT_ATTEMPTS = 3;
/** Stop reusing a cached macaroon this many seconds before it expires. */
const MACAROON_SAFETY_MARGIN = 30;
const DEFAULT_VOUCHER_TTL = 86_400;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function termsFrom(request: PaymentRequest): PaymentTerms {
  return {
    provider: getAddress(request.provider),
    escrow: getAddress(request.escrow),
    chainId: request.chainId,
    token: getAddress(request.token),
    price: BigInt(request.amount),
    ...(request.cumulativeAmount ? { cumulativeAmount: BigInt(request.cumulativeAmount) } : {}),
    ...(request.lastVoucher ? { lastVoucher: request.lastVoucher } : {}),
    validUntil: BigInt(request.validUntil),
    source: request,
  };
}

/**
 * `fetch` that speaks L402-EL2.
 *
 * In steady state it costs a single round trip: after the first 402 the client
 * knows price and macaroon of the resource and attaches the voucher to the very
 * first request. The 402 only comes back when the macaroon expires or the price
 * changes, and then the client re-aligns on its own.
 */
export function createL402Fetch(options: L402FetchOptions): typeof globalThis.fetch {
  const { channels, policy } = options;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const credentials = new Map<string, CachedCredential>();
  /** Cumulative amount already signed when the session started, per provider. */
  const baseline = new Map<string, bigint>();
  let topUps = 0;

  /**
   * Real spending of the session.
   *
   * It is not the sum of the prices seen: vouchers are cumulative, so the
   * agent's liability is always the highest amount signed. If a signature is
   * wasted (price changed, re-alignment 402) the next voucher absorbs it and it
   * must not be counted twice.
   */
  function spentSoFar(): bigint {
    let total = 0n;
    for (const [provider, start] of baseline) {
      total += channels.getCumulative(provider as Address) - start;
    }
    return total;
  }

  function rememberBaseline(provider: Address): void {
    const key = provider.toLowerCase();
    if (!baseline.has(key)) baseline.set(key, channels.getCumulative(provider));
  }

  /**
   * Cache key for credentials. It includes the billed resource, not only the
   * URL: on MCP every call hits `POST /mcp`, and reusing the price of one tool
   * for another would sign wrong vouchers.
   */
  function credentialKey(url: string, method: string, body: RequestInit["body"]): string {
    const parsed = new URL(url);
    return `${method.toUpperCase()} ${parsed.origin}${parsed.pathname} ${jsonRpcResource(body) ?? ""}`.trimEnd();
  }

  /**
   * Static checks on who we are about to pay. Runs before any signature AND
   * before any auto top-up: a malicious server must not be able to make the
   * agent deposit funds towards a provider the policy does not allow.
   */
  function assertAllowed(terms: PaymentTerms): void {
    const refuse = (message: string): never => {
      throw new PaymentRefused(message, terms.source);
    };
    if (terms.price > policy.maxPricePerCall) {
      refuse(`Price ${terms.price} exceeds the per-call maximum (${policy.maxPricePerCall})`);
    }
    if (policy.allowedProviders && !policy.allowedProviders.some((p) => getAddress(p) === terms.provider)) {
      refuse(`Provider not allowed: ${terms.provider}`);
    }
    if (policy.allowedEscrows && !policy.allowedEscrows.some((e) => getAddress(e) === terms.escrow)) {
      refuse(`Escrow not allowed: ${terms.escrow}`);
    }
    if (policy.allowedChainIds && !policy.allowedChainIds.includes(terms.chainId)) {
      refuse(`Chain not allowed: ${terms.chainId}`);
    }
    // Vouchers are always signed for the ChannelManager's own chain/escrow/token:
    // a challenge asking for anything else could never be honoured.
    if (
      terms.chainId !== channels.chainId ||
      terms.escrow !== getAddress(channels.escrow) ||
      terms.token !== getAddress(channels.token)
    ) {
      refuse(
        `The server asks for chain ${terms.chainId}, escrow ${terms.escrow}, token ${terms.token}, ` +
          `but this wallet pays on chain ${channels.chainId}, escrow ${channels.escrow}, token ${channels.token}`,
      );
    }
  }

  async function authorizationFor(terms: PaymentTerms, macaroon: Macaroon, url: string): Promise<string> {
    rememberBaseline(terms.provider);
    assertAllowed(terms);

    // After a restart the local counter may be behind what the server already
    // holds. Adopting a verified voucher is not new spending of this session, so
    // the baseline moves up by the same amount.
    if (terms.lastVoucher) {
      const raised = await channels.adoptServerState(terms.provider, terms.lastVoucher);
      if (raised > 0n) {
        const key = terms.provider.toLowerCase();
        baseline.set(key, (baseline.get(key) ?? 0n) + raised);
      }
    }

    // The server proposes the cumulative amount; if it did not, we compute it.
    const target = terms.cumulativeAmount ?? channels.getCumulative(terms.provider) + terms.price;

    const signed = await channels.signNext(terms.provider, target, {
      validUntil: terms.validUntil,
      approve: (increment) => {
        if (increment > policy.maxPricePerCall) {
          throw new PaymentRefused(
            `The server asks for ${increment} more than already signed, above the per-call maximum (${policy.maxPricePerCall})`,
            terms.source,
          );
        }
        const spent = spentSoFar();
        if (spent + increment > policy.totalBudget) {
          throw new PaymentRefused(
            `Budget exhausted: spent ${spent}, requested ${increment}, budget ${policy.totalBudget}`,
            terms.source,
          );
        }
      },
    });

    options.onPayment?.({ provider: terms.provider, amount: signed.increment, cumulative: target, url });

    return buildAuthorizationHeader(
      encodeMacaroon(macaroon),
      proofFromSignedVoucher({ voucher: signed.voucher, signature: signed.signature, signer: signed.signer }),
    );
  }

  return async function l402Fetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const key = credentialKey(url, method, init?.body);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(PAYER_HEADER, channels.address);

    // Optimistic payment: if price and macaroon are already known, skip the 402.
    const cached = credentials.get(key);
    if (cached && cached.expiresAt > nowSeconds() && !headers.has("authorization")) {
      try {
        const authorization = await authorizationFor(
          {
            provider: cached.provider,
            escrow: cached.escrow,
            chainId: cached.chainId,
            token: cached.token,
            price: cached.price,
            validUntil: BigInt(nowSeconds() + cached.voucherTtl),
          },
          cached.macaroon,
          url,
        );
        headers.set("authorization", authorization);
      } catch (error) {
        if (error instanceof PaymentRefused) throw error;
        credentials.delete(key);
      }
    }

    let response = await baseFetch(input, { ...init, headers });
    if (response.status !== 402 && response.status !== 401) return response;

    // The cached macaroon is no longer good: start again from the challenge.
    credentials.delete(key);

    for (let attempt = 0; attempt < MAX_PAYMENT_ATTEMPTS; attempt++) {
      const challengeHeader = response.headers.get("www-authenticate");
      if (!challengeHeader) return response;

      let parsed;
      try {
        parsed = parseChallengeHeader(challengeHeader);
      } catch {
        return response; // not an L402 challenge: let the caller handle it
      }
      const { paymentRequest, macaroon } = parsed;
      const terms = termsFrom(paymentRequest);

      // Insufficient deposit: possibly top up the channel and retry.
      const errorCode = (await readErrorCode(response)) ?? "";
      const canTopUp = options.autoTopUp !== undefined && topUps < (options.autoTopUp.maxTimes ?? 1);
      if (NEEDS_FUNDING.has(errorCode) && canTopUp) {
        assertAllowed(terms);
        topUps++;
        await channels.open(terms.provider, options.autoTopUp!.amount);
      } else if (UNPAYABLE.has(errorCode)) {
        return response; // a new signature would not help: let the caller see the error
      }

      headers.set("authorization", await authorizationFor(terms, macaroon, url));
      response = await baseFetch(input, { ...init, headers });

      if (response.status !== 402 && response.status !== 401) {
        const now = nowSeconds();
        credentials.set(key, {
          macaroon,
          provider: terms.provider,
          price: terms.price,
          escrow: terms.escrow,
          chainId: terms.chainId,
          token: terms.token,
          voucherTtl: Math.max(0, paymentRequest.validUntil - now) || DEFAULT_VOUCHER_TTL,
          expiresAt: (macaroonExpiry(macaroon) ?? now + 300) - MACAROON_SAFETY_MARGIN,
        });
        return response;
      }
      headers.delete("authorization");
    }

    return response;
  };
}

/**
 * If the body is a JSON-RPC message (MCP transport), returns the billed
 * resource: the tool name for `tools/call`, otherwise the method.
 */
function jsonRpcResource(body: RequestInit["body"]): string | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const parts: string[] = [];
  for (const message of messages as { method?: string; params?: { name?: string; uri?: string } }[]) {
    if (!message?.method) continue;
    parts.push(message.params?.name ?? message.params?.uri ?? message.method);
  }
  return parts.length ? parts.join("+") : undefined;
}

/**
 * Extracts the L402 error code from both the HTTP form (`{ error: "..." }`) and
 * the JSON-RPC form used by the MCP transport (`{ error: { data: { l402: "..." } } }`).
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { error?: string | { data?: { l402?: string } } } | undefined;
  const error = body?.error;
  if (typeof error === "string") return error;
  return error?.data?.l402;
}

/** Human-readable spend summary, for agent logs. */
export function describeSpend(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`;
}
