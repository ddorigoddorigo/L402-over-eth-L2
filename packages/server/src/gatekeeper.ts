import { getAddress, isErc6492Signature, zeroAddress, type Address, type Hex } from "viem";
import {
  buildChallengeHeader,
  caveat,
  CaveatKeys,
  CLOSE_CHALLENGE_PERIOD,
  computeChannelId,
  encodeMacaroon,
  isAddressLike,
  mintMacaroon,
  newTokenId,
  parseAuthorizationHeader,
  signedVoucherFromProof,
  verifyMacaroon,
  voucherTypedData,
  type Caveat,
  type L402Credentials,
  type L402ErrorCode,
  type Macaroon,
  type PaymentRequest,
  type SignedVoucher,
  type Voucher,
} from "@l402-el2/core";

import { ChainReader, type ChannelState } from "./chain.js";
import { priceFor, resolveConfig, type GatekeeperConfig, type Price, type ResolvedConfig } from "./config.js";
import type { StoredVoucher } from "./store/index.js";

export interface ChallengeInput {
  /** Requested resource: MCP tool name or HTTP path. */
  resource: string;
  /** Payer address, if declared (`X-L402-Payer` header). */
  payer?: string;
  /** Human-readable description shown to the client. */
  description?: string;
}

export interface Challenge {
  macaroon: Macaroon;
  macaroonEncoded: string;
  paymentRequest: PaymentRequest;
  /** Ready-to-use value for the `WWW-Authenticate` header. */
  header: string;
  price: bigint;
}

export interface AuthorizeInput {
  /** Content of the `Authorization` header. */
  authorization: string | undefined;
  resource: string;
  payerHint?: string;
}

export type AuthorizeResult =
  | {
      ok: true;
      payer: Address;
      channelId: Hex;
      price: bigint;
      /** Cumulative amount after this call. */
      cumulativeAmount: bigint;
      /** Actual increment over the previous voucher. */
      delta: bigint;
      /** Estimated remaining balance of the channel. */
      remaining: bigint;
      macaroonEncoded: string;
      tokenId: string;
    }
  | {
      ok: false;
      code: L402ErrorCode;
      reason: string;
      /** Challenge to send back with the 402. */
      challenge: Challenge;
    };

/** Internal: a verification step either passes or explains why it failed. */
type StepFailure = { code: L402ErrorCode; reason: string };

/**
 * The server-side brain of L402-EL2: it issues 402 challenges and verifies the
 * `Authorization: L402 <macaroon>:<voucher>` credentials of paid requests.
 *
 * `authorize` runs these checks, cheapest first:
 *   1. credentials are present and well-formed;
 *   2. the macaroon is not revoked, is bound to a payer, has a valid HMAC chain
 *      and all its caveats hold;
 *   3. the voucher targets the payer's channel and lives long enough to be settled;
 *   4. the signer is the payer or a live session key within its cap;
 *   5. the EIP-712 signature is valid (EOA or ERC-1271 smart account);
 *   6. the channel exists on-chain, will stay open long enough and covers the amount;
 *   7. the voucher pays at least the resource price on top of the last accepted one,
 *      and the store advances atomically (no double spending under concurrency).
 */
export class Gatekeeper {
  private readonly config: ResolvedConfig;
  readonly chain: ChainReader;

  constructor(config: GatekeeperConfig) {
    this.config = resolveConfig(config);
    this.chain = new ChainReader(config.publicClient, config.escrow, this.config.chainCacheTtlMs);
  }

  get provider(): Address {
    return this.config.provider;
  }

  /** Price of a resource according to the configured pricing policy. */
  priceOf(resource: string): Price {
    return priceFor(this.config.pricing, resource);
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  private channelIdOf(payer: Address): Hex {
    return computeChannelId(payer, this.config.provider, this.config.token);
  }

  /* ------------------------------- CHALLENGE ------------------------------- */

  /**
   * Issues the 402: macaroon + payment request.
   *
   * When the client declared its address (`X-L402-Payer` header), the macaroon is
   * bound to payer and channel, and the payment request already carries the exact
   * cumulative amount to sign: the client only needs a local signature, no RPC.
   */
  async challenge(input: ChallengeInput): Promise<Challenge> {
    const price = this.priceOf(input.resource);
    const now = this.now();
    const payer = isAddressLike(input.payer) ? getAddress(input.payer) : undefined;

    const caveats: Caveat[] = [
      caveat(CaveatKeys.service, "=", this.config.service),
      caveat(CaveatKeys.chainId, "=", this.config.chainId),
      caveat(CaveatKeys.token, "=", this.config.token.toLowerCase()),
      caveat(CaveatKeys.expiresAt, "<=", now + this.config.macaroonTtl),
    ];

    let channelId: Hex | undefined;
    let nextCumulative: bigint | undefined;

    let lastVoucher: PaymentRequest["lastVoucher"];
    if (payer) {
      channelId = this.channelIdOf(payer);
      const last = await this.config.store.get(channelId);
      nextCumulative = (await this.acceptedFloor(channelId)) + price;
      if (last) {
        lastVoucher = {
          channelId: last.channelId,
          cumulativeAmount: last.cumulativeAmount,
          nonce: last.nonce,
          validUntil: last.validUntil,
          signature: last.signature,
          ...(last.signer ? { signer: last.signer } : {}),
        };
      }

      caveats.push(caveat(CaveatKeys.payer, "=", payer.toLowerCase()));
      caveats.push(caveat(CaveatKeys.channelId, "=", channelId.toLowerCase()));
      if (this.config.macaroonMaxCumulative > 0n) {
        caveats.push(caveat(CaveatKeys.maxCumulative, "<=", nextCumulative + this.config.macaroonMaxCumulative));
      }
    }

    const macaroon = mintMacaroon({
      rootKey: this.config.rootKey,
      service: this.config.service,
      tokenId: newTokenId(),
      ...(channelId ? { channelId } : {}),
      caveats,
    });

    const paymentRequest: PaymentRequest = {
      scheme: "l402-el2",
      version: 1,
      chainId: this.config.chainId,
      escrow: this.config.escrow,
      token: this.config.token,
      tokenSymbol: this.config.tokenSymbol,
      tokenDecimals: this.config.tokenDecimals,
      provider: this.config.provider,
      amount: price.toString(),
      validUntil: now + this.config.voucherTtl,
      minDeposit: this.config.minDeposit.toString(),
      description: input.description ?? input.resource,
      ...(channelId ? { channelId } : {}),
      ...(nextCumulative !== undefined ? { cumulativeAmount: nextCumulative.toString() } : {}),
      ...(lastVoucher ? { lastVoucher } : {}),
    };

    return {
      macaroon,
      macaroonEncoded: encodeMacaroon(macaroon),
      paymentRequest,
      header: buildChallengeHeader(macaroon, paymentRequest),
      price,
    };
  }

  /**
   * Cumulative amount the next voucher must exceed: the last voucher this server
   * accepted, or the on-chain floor if that is higher (e.g. the store was reset,
   * or the channel was refunded). A voucher at or below the on-chain floor could
   * never be settled.
   *
   * Without a fresh channel state (challenge path) only the cached one is used:
   * challenges are unauthenticated, and reading the chain for every
   * `X-L402-Payer` anyone sends would turn the server into an RPC amplifier. If
   * the hint is too low, `authorize` reads the chain and the next challenge
   * carries the right amount.
   */
  private async acceptedFloor(channelId: Hex, channel?: ChannelState): Promise<bigint> {
    const last = await this.config.store.get(channelId);
    const stored = last ? BigInt(last.cumulativeAmount) : 0n;
    const onChain = (channel ?? this.chain.peekChannel(channelId))?.cumulativeFloor ?? 0n;
    return stored > onChain ? stored : onChain;
  }

  /* ----------------------------- AUTHORIZATION ----------------------------- */

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const price = this.priceOf(input.resource);
    const now = this.now();

    const fail = async ({ code, reason }: StepFailure, payer?: string): Promise<AuthorizeResult> => {
      const payerForChallenge = payer ?? input.payerHint;
      return {
        ok: false,
        code,
        reason,
        challenge: await this.challenge({
          resource: input.resource,
          ...(payerForChallenge ? { payer: payerForChallenge } : {}),
        }),
      };
    };

    // 1. Credentials present and well-formed.
    if (!input.authorization) {
      return fail({ code: "missing_credentials", reason: "Missing Authorization header" });
    }
    let credentials: L402Credentials;
    try {
      credentials = parseAuthorizationHeader(input.authorization);
    } catch (error) {
      return fail({ code: "malformed_credentials", reason: (error as Error).message });
    }
    const { macaroon, macaroonRaw, proof } = credentials;
    if (proof.type !== "voucher") {
      return fail({ code: "invalid_proof", reason: `Proof type not supported by this server: ${proof.type}` });
    }

    // 2. Macaroon: payer binding, signature, caveats, revocation.
    const payer = this.payerOf(macaroon);
    const channelId = payer ? this.channelIdOf(payer) : undefined;
    // The binding must come from the server: the identifier is part of the HMAC
    // root, while a `payer` caveat could have been appended by the holder of an
    // unbound macaroon (skipping the server's `max_cumulative` cap).
    if (!payer || !channelId || macaroon.identifier.channelId?.toLowerCase() !== channelId.toLowerCase()) {
      return fail({
        code: "invalid_macaroon",
        reason: "Macaroon not bound to a payer: repeat the request with the X-L402-Payer header",
      });
    }
    const signed = signedVoucherFromProof(proof);
    const { voucher } = signed;

    const macaroonCheck = verifyMacaroon(this.config.rootKey, macaroon, {
      [CaveatKeys.service]: this.config.service,
      [CaveatKeys.chainId]: this.config.chainId,
      [CaveatKeys.token]: this.config.token.toLowerCase(),
      [CaveatKeys.expiresAt]: now,
      [CaveatKeys.payer]: payer.toLowerCase(),
      [CaveatKeys.channelId]: channelId.toLowerCase(),
      [CaveatKeys.maxCumulative]: voucher.cumulativeAmount,
      [CaveatKeys.tool]: input.resource,
    });
    if (!macaroonCheck.ok) return fail(macaroonCheck, payer);
    // Checked after the HMAC, so forged token ids never reach the store.
    if (await this.config.store.isRevoked(macaroon.identifier.tokenId)) {
      return fail({ code: "revoked", reason: "Macaroon revoked" }, payer);
    }

    // 3. Voucher targets the right channel and can still be settled.
    const voucherFailure = this.checkVoucher(voucher, channelId, now);
    if (voucherFailure) return fail(voucherFailure, payer);

    // 4. Signer: the payer itself or a live session key.
    const signer = this.signerOf(signed, payer);
    if (signer !== payer) {
      const delegationFailure = await this.checkDelegation(payer, signer, voucher, now);
      if (delegationFailure) return fail(delegationFailure, payer);
    }

    // 5. Cryptographic signature check (EOA or ERC-1271 smart account).
    if (isErc6492Signature(signed.signature)) {
      // ERC-6492 is how viem signs for smart accounts that are not deployed yet.
      // viem can verify it off-chain, but the escrow (SignatureChecker / ERC-1271)
      // cannot, so such a voucher could never be settled.
      return fail(
        { code: "invalid_signature", reason: "ERC-6492 signatures cannot be settled: deploy the smart account first" },
        payer,
      );
    }
    if (!(await this.verifyVoucherSignature(signer, voucher, signed.signature))) {
      return fail({ code: "invalid_signature", reason: "Invalid voucher signature" }, payer);
    }

    // 6. On-chain coverage of the channel.
    const channel = await this.chain.getChannel(channelId);
    const channelFailure = this.checkChannel(channel, voucher, now);
    if (channelFailure) return fail(channelFailure, payer);

    // 7. Price and atomic advance of the channel state (no concurrent double spending).
    const floor = await this.acceptedFloor(channelId, channel);
    const required = floor + price;
    if (voucher.cumulativeAmount < required) {
      return fail(
        {
          code: "insufficient_payment",
          reason: `Insufficient voucher: expected at least ${required}, received ${voucher.cumulativeAmount}`,
        },
        payer,
      );
    }

    const stored: StoredVoucher = {
      channelId,
      payer,
      cumulativeAmount: voucher.cumulativeAmount.toString(),
      nonce: Number(voucher.nonce),
      validUntil: Number(voucher.validUntil),
      signature: signed.signature,
      updatedAt: Date.now(),
      ...(signer !== payer ? { signer } : {}),
    };
    const advanced = await this.config.store.advance(stored, required);
    if (!advanced.ok) {
      return fail(
        {
          code: "voucher_not_monotonic",
          reason: "Voucher already used or not increasing: sign a new one starting from the latest cumulative amount",
        },
        payer,
      );
    }

    return {
      ok: true,
      payer,
      channelId,
      price,
      cumulativeAmount: voucher.cumulativeAmount,
      delta: voucher.cumulativeAmount - floor,
      // The cumulative counter already includes what was settled or refunded.
      remaining: channel.deposited - voucher.cumulativeAmount,
      macaroonEncoded: macaroonRaw,
      tokenId: macaroon.identifier.tokenId,
    };
  }

  /* ---------------------------- VERIFICATION STEPS -------------------------- */

  /** The payer the macaroon was minted for (its first `payer` caveat). */
  private payerOf(macaroon: Macaroon): Address | undefined {
    const payerCaveat = macaroon.caveats.find((c) => c.key === CaveatKeys.payer);
    return payerCaveat && isAddressLike(payerCaveat.value) ? getAddress(payerCaveat.value) : undefined;
  }

  /** Declared signer, defaulting to the payer when absent or zero. */
  private signerOf(signed: SignedVoucher, payer: Address): Address {
    return signed.signer && signed.signer !== zeroAddress ? getAddress(signed.signer) : payer;
  }

  private checkVoucher(voucher: Voucher, channelId: Hex, now: number): StepFailure | undefined {
    if (voucher.channelId.toLowerCase() !== channelId.toLowerCase()) {
      return { code: "invalid_proof", reason: "The voucher refers to a different channel than the macaroon" };
    }
    // The provider can only settle before `validUntil`: a voucher that expires
    // before the settler gets to it is worthless.
    const minValidUntil = BigInt(now + this.config.minVoucherTimeLeft);
    if (voucher.validUntil < minValidUntil) {
      return {
        code: "voucher_expired",
        reason: `Voucher expires too soon to be settled: validUntil must be at least ${minValidUntil}`,
      };
    }
    return undefined;
  }

  private async checkDelegation(
    payer: Address,
    signer: Address,
    voucher: Voucher,
    now: number,
  ): Promise<StepFailure | undefined> {
    const delegation = await this.chain.getDelegation(payer, signer);
    if (!delegation.active) {
      return { code: "delegation_invalid", reason: `Session key ${signer} is not authorized by the payer` };
    }
    // Same reasoning as for the channel: the key must still be valid at settlement time.
    if (delegation.validUntil < BigInt(now + this.config.minChannelTimeLeft)) {
      return { code: "delegation_invalid", reason: "Session key delegation expires (or was revoked) too soon" };
    }
    if (voucher.cumulativeAmount > delegation.maxCumulative) {
      return {
        code: "delegation_invalid",
        reason: `The voucher (${voucher.cumulativeAmount}) exceeds the session key cap (${delegation.maxCumulative})`,
      };
    }
    return undefined;
  }

  private checkChannel(channel: ChannelState, voucher: Voucher, now: number): StepFailure | undefined {
    if (!channel.exists) {
      return { code: "channel_not_found", reason: "No open channel towards this provider: open one and retry" };
    }
    // After a close request the payer can withdraw once the challenge period ends.
    const closesAt =
      channel.closeRequestedAt !== 0n && channel.closeRequestedAt + CLOSE_CHALLENGE_PERIOD < channel.expiry
        ? channel.closeRequestedAt + CLOSE_CHALLENGE_PERIOD
        : channel.expiry;
    if (closesAt < BigInt(now + this.config.minChannelTimeLeft)) {
      return {
        code: "channel_closing",
        reason: `The channel closes too soon to guarantee settlement (at ${closesAt}): extend or top it up`,
      };
    }
    if (voucher.cumulativeAmount > channel.deposited) {
      return {
        code: "insufficient_deposit",
        reason: `Insufficient deposit: voucher needs ${voucher.cumulativeAmount - channel.cumulativeFloor}, available ${channel.available}`,
      };
    }
    return undefined;
  }

  /**
   * Verifies the EIP-712 signature. `publicClient.verifyTypedData` covers both
   * EOAs (local ecrecover) and deployed ERC-4337 smart accounts (ERC-1271 call).
   */
  private async verifyVoucherSignature(signer: Address, voucher: Voucher, signature: Hex): Promise<boolean> {
    const typedData = voucherTypedData(this.config.chainId, this.config.escrow, voucher);
    try {
      return await this.config.publicClient.verifyTypedData({
        address: signer,
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message as unknown as Record<string, unknown>,
        signature,
      });
    } catch {
      return false;
    }
  }

  /* --------------------------------- OTHER --------------------------------- */

  /** Revokes a macaroon (e.g. after detecting abuse). */
  async revoke(tokenId: string): Promise<void> {
    await this.config.store.revoke(tokenId, this.config.macaroonTtl);
  }

  /** Public description of the service, served at `/.well-known/l402`. */
  discovery() {
    return {
      scheme: "l402-el2" as const,
      version: 1 as const,
      service: this.config.service,
      chainId: this.config.chainId,
      escrow: this.config.escrow,
      token: this.config.token,
      tokenSymbol: this.config.tokenSymbol,
      tokenDecimals: this.config.tokenDecimals,
      provider: this.config.provider,
      minDeposit: this.config.minDeposit.toString(),
      voucherTtl: this.config.voucherTtl,
      minVoucherTimeLeft: this.config.minVoucherTimeLeft,
      minChannelTimeLeft: this.config.minChannelTimeLeft,
      pricing: {
        default: this.config.pricing.default.toString(),
        resources: Object.fromEntries(
          Object.entries(this.config.pricing.resources ?? {}).map(([name, price]) => [name, price.toString()]),
        ),
      },
      payerHeader: "X-L402-Payer",
    };
  }
}
