import {
  encodeFunctionData,
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  computeChannelId,
  erc20Abi,
  escrowAbi,
  signedVoucherFromProof,
  voucherTypedData,
  type SerializedSignedVoucher,
  type Voucher,
} from "@l402-el2/core";
import { approveCall, type L402Wallet } from "./wallet.js";

export interface ChannelManagerOptions {
  wallet: L402Wallet;
  publicClient: PublicClient;
  chainId: number;
  escrow: Address;
  token: Address;
  /** Default channel lifetime in seconds. Default 30 days. */
  defaultDuration?: bigint;
  /** Lifetime of signed vouchers when the server does not suggest one (seconds). Default 86400. */
  voucherTtl?: number;
}

export interface ChannelSnapshot {
  channelId: Hex;
  deposited: bigint;
  claimed: bigint;
  refunded: bigint;
  available: bigint;
  /** claimed + refunded: the next voucher must be above this value. */
  cumulativeFloor: bigint;
  expiry: bigint;
  closeRequestedAt: bigint;
  exists: boolean;
}

export interface SignNextOptions {
  /** Refuse to sign if the voucher raises the liability by more than this. */
  maxIncrement?: bigint;
  /** Voucher expiry (unix seconds). Default: now + `voucherTtl`. */
  validUntil?: bigint;
  /**
   * Last-chance check, called synchronously with the increment right before the
   * amount is reserved. Throw to refuse (e.g. budget exhausted).
   */
  approve?: (increment: bigint) => void;
}

export interface SignedNext {
  voucher: Voucher;
  signature: Hex;
  signer: Address;
  /** How much this voucher adds to what was already signed (0 if it re-signs a lower amount). */
  increment: bigint;
}

/**
 * Manages the lifecycle of channels and the generation of vouchers.
 *
 * The cumulative state is kept in memory to avoid an RPC read before every
 * signature. The server still communicates the next expected amount in every
 * 402 challenge, so the client re-synchronizes on its own (`syncCumulative`)
 * even after a restart.
 *
 * Liability model: the provider can always settle the HIGHEST voucher ever
 * signed, so `getCumulative()` tracks that maximum. Signing a voucher for a lower
 * amount than the maximum costs nothing extra.
 */
export class ChannelManager {
  private readonly options: Required<ChannelManagerOptions>;
  /** Highest cumulative amount signed so far, per provider. */
  private readonly cumulative = new Map<string, bigint>();
  private readonly nonces = new Map<string, bigint>();

  constructor(options: ChannelManagerOptions) {
    this.options = {
      ...options,
      defaultDuration: options.defaultDuration ?? 30n * 24n * 3600n,
      voucherTtl: options.voucherTtl ?? 86_400,
    };
  }

  get address(): Address {
    return this.options.wallet.address;
  }

  get chainId(): number {
    return this.options.chainId;
  }

  get escrow(): Address {
    return this.options.escrow;
  }

  get token(): Address {
    return this.options.token;
  }

  channelId(provider: Address): Hex {
    return computeChannelId(this.options.wallet.address, provider, this.options.token);
  }

  /** On-chain state of the channel towards a provider. */
  async snapshot(provider: Address): Promise<ChannelSnapshot> {
    const channelId = this.channelId(provider);
    const channel = (await this.options.publicClient.readContract({
      address: this.options.escrow,
      abi: escrowAbi,
      functionName: "getChannel",
      args: [channelId],
    })) as Omit<ChannelSnapshot, "channelId" | "available" | "cumulativeFloor">;
    return {
      channelId,
      deposited: channel.deposited,
      claimed: channel.claimed,
      refunded: channel.refunded,
      available: channel.deposited - channel.claimed - channel.refunded,
      cumulativeFloor: channel.claimed + channel.refunded,
      expiry: channel.expiry,
      closeRequestedAt: channel.closeRequestedAt,
      exists: channel.exists,
    };
  }

  /**
   * Opens or tops up the channel. With a smart account, `approve` and
   * `openChannel` go into a single atomic UserOperation.
   */
  async open(provider: Address, amount: bigint, duration = this.options.defaultDuration): Promise<Hex> {
    const calls = await this.approvalCallsFor(amount);
    calls.push({
      to: this.options.escrow,
      data: encodeFunctionData({
        abi: escrowAbi,
        functionName: "openChannel",
        args: [getAddress(provider), this.options.token, amount, duration],
      }),
    });

    const hash = await this.options.wallet.sendCalls(calls);
    await this.syncCumulative(provider);
    return hash;
  }

  /** Tops up an existing channel and extends its expiry (approving the escrow first if needed). */
  async topUp(provider: Address, amount: bigint, newExpiry?: bigint): Promise<Hex> {
    const expiry = newExpiry ?? BigInt(Math.floor(Date.now() / 1000)) + this.options.defaultDuration;
    const calls = await this.approvalCallsFor(amount);
    calls.push({
      to: this.options.escrow,
      data: encodeFunctionData({
        abi: escrowAbi,
        functionName: "topUp",
        args: [this.channelId(provider), amount, expiry],
      }),
    });
    return this.options.wallet.sendCalls(calls);
  }

  /** `approve` call to prepend when the escrow's allowance does not cover `amount`. */
  private async approvalCallsFor(amount: bigint): Promise<{ to: Address; data: Hex }[]> {
    const allowance = (await this.options.publicClient.readContract({
      address: this.options.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.options.wallet.address, this.options.escrow],
    })) as bigint;
    return allowance < amount ? [approveCall(this.options.token, this.options.escrow)] : [];
  }

  /** Starts a unilateral close (the provider gets 24h to settle). */
  async requestClose(provider: Address): Promise<Hex> {
    return this.callEscrow("requestClose", provider);
  }

  /** Withdraws the remainder after the challenge period or the channel expiry. */
  async withdraw(provider: Address): Promise<Hex> {
    return this.callEscrow("withdraw", provider);
  }

  private callEscrow(functionName: "requestClose" | "withdraw", provider: Address): Promise<Hex> {
    return this.options.wallet.sendCalls([
      {
        to: this.options.escrow,
        data: encodeFunctionData({ abi: escrowAbi, functionName, args: [this.channelId(provider)] }),
      },
    ]);
  }

  /** Aligns the local counter with the on-chain floor (settled + refunded). */
  async syncCumulative(provider: Address): Promise<bigint> {
    const { cumulativeFloor } = await this.snapshot(provider);
    this.setCumulative(provider, cumulativeFloor);
    return this.getCumulative(provider);
  }

  /** Raises the local counter (it never goes down: see the liability model above). */
  setCumulative(provider: Address, value: bigint): void {
    const key = provider.toLowerCase();
    if (value > (this.cumulative.get(key) ?? 0n)) this.cumulative.set(key, value);
  }

  /** Highest cumulative amount signed (or known to be consumed) for this provider. */
  getCumulative(provider: Address): bigint {
    return this.cumulative.get(provider.toLowerCase()) ?? 0n;
  }

  /**
   * Re-synchronizes with a voucher the server says it accepted (the payment
   * request's `lastVoucher`), e.g. after this process restarted and lost its
   * in-memory counter.
   *
   * The server is not trusted: the voucher is adopted only if it is provably
   * settleable on-chain anyway — right channel, not expired, and signed by this
   * payer or by a session key the payer delegated with a cap covering it. Such a
   * voucher is already a liability, so acknowledging it costs nothing.
   *
   * @returns the amount by which the local counter was raised (0 if not adopted).
   */
  async adoptServerState(provider: Address, proof: SerializedSignedVoucher): Promise<bigint> {
    const { voucher, signature, signer } = signedVoucherFromProof({ type: "voucher", ...proof });
    const before = this.getCumulative(provider);
    if (voucher.cumulativeAmount <= before) return 0n;
    if (voucher.channelId.toLowerCase() !== this.channelId(provider).toLowerCase()) return 0n;
    if (voucher.validUntil <= BigInt(Math.floor(Date.now() / 1000))) return 0n;

    const payer = getAddress(this.options.wallet.address);
    const declared = signer ? getAddress(signer) : payer;
    if (!(await this.isOurSigner(declared, voucher.cumulativeAmount))) return 0n;
    if (!(await this.isValidSignature(declared, voucher, signature))) return 0n;

    this.setCumulative(provider, voucher.cumulativeAmount);
    return this.getCumulative(provider) - before;
  }

  /** The payer, the current session key, or any key the payer delegated on-chain with enough cap. */
  private async isOurSigner(signer: Address, amount: bigint): Promise<boolean> {
    const payer = getAddress(this.options.wallet.address);
    if (signer === payer || signer === getAddress(this.options.wallet.signerAddress)) return true;
    try {
      const [maxCumulative, validUntil, active] = (await this.options.publicClient.readContract({
        address: this.options.escrow,
        abi: escrowAbi,
        functionName: "delegations",
        args: [payer, signer],
      })) as readonly [bigint, bigint, boolean];
      return active && amount <= maxCumulative && validUntil > BigInt(Math.floor(Date.now() / 1000));
    } catch {
      return false;
    }
  }

  private async isValidSignature(signer: Address, voucher: Voucher, signature: Hex): Promise<boolean> {
    const typedData = voucherTypedData(this.options.chainId, this.options.escrow, voucher);
    try {
      if ((await recoverTypedDataAddress({ ...typedData, signature })) === signer) return true;
    } catch {
      // not a plain ECDSA signature: may be an ERC-1271 smart account
    }
    try {
      return await this.options.publicClient.verifyTypedData({
        address: signer,
        ...typedData,
        message: typedData.message as unknown as Record<string, unknown>,
        signature,
      });
    } catch {
      return false;
    }
  }

  /**
   * Signs the next voucher for `target`, the cumulative amount requested by the server.
   *
   * The client does not trust the target blindly: if it would raise the
   * liability by more than `maxIncrement`, it is an over-billing attempt and is
   * refused. A target at or below what was already signed is fine (increment 0):
   * it happens when a previous voucher was rejected, or with concurrent calls.
   *
   * The amount is reserved synchronously before the (async) signature, so
   * concurrent calls always compute their increment against up-to-date state.
   */
  async signNext(provider: Address, target: bigint, options: SignNextOptions = {}): Promise<SignedNext> {
    const key = provider.toLowerCase();
    const current = this.cumulative.get(key) ?? 0n;
    const increment = target > current ? target - current : 0n;

    if (options.maxIncrement !== undefined && increment > options.maxIncrement) {
      throw new Error(
        `Requested increment too high: ${increment} > limit ${options.maxIncrement}. Payment refused.`,
      );
    }
    options.approve?.(increment);

    const nonce = (this.nonces.get(key) ?? 0n) + 1n;
    this.nonces.set(key, nonce);
    if (increment > 0n) this.cumulative.set(key, target);

    const voucher: Voucher = {
      channelId: this.channelId(provider),
      cumulativeAmount: target,
      nonce,
      validUntil: options.validUntil ?? BigInt(Math.floor(Date.now() / 1000) + this.options.voucherTtl),
    };
    let signature: Hex;
    try {
      signature = await this.options.wallet.signVoucher(this.options.chainId, this.options.escrow, voucher);
    } catch (error) {
      // Nothing was signed: release the reservation, unless another call built on it meanwhile.
      if (increment > 0n && this.cumulative.get(key) === target) this.cumulative.set(key, current);
      throw error;
    }
    return { voucher, signature, signer: this.options.wallet.signerAddress, increment };
  }
}
