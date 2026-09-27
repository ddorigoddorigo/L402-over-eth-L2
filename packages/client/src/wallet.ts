import {
  encodeFunctionData,
  getAddress,
  maxUint256,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { erc20Abi, escrowAbi, voucherTypedData, delegationTypedData, type Voucher } from "@l402-el2/core";

/**
 * Abstraction of the agent's wallet.
 *
 * The protocol does not dictate how the agent holds its keys: an EOA for simple
 * setups, an ERC-4337 smart account for session keys and batching, or a
 * delegated session key signing on behalf of the account.
 */
export interface L402Wallet {
  /** Address that owns the channel (the "payer"). */
  readonly address: Address;
  /**
   * Address that actually signs the vouchers. Differs from `address` when a
   * session key is used: it is sent to the server in the proof's `signer` field.
   */
  readonly signerAddress: Address;
  /** Signs an EIP-712 voucher. Must be purely local: no RPC, no gas. */
  signVoucher(chainId: number, escrow: Address, voucher: Voucher): Promise<Hex>;
  /**
   * Executes one or more on-chain calls. Smart accounts run them atomically in a
   * single UserOperation.
   */
  sendCalls(calls: { to: Address; data: Hex; value?: bigint }[]): Promise<Hex>;
}

export interface EoaWalletOptions {
  account: Account;
  walletClient: WalletClient;
  publicClient: PublicClient;
}

/**
 * EOA wallet. Multiple calls become sequential transactions: with WBTC that means
 * `approve` then `openChannel`, two transactions and two block confirmations.
 * That is why cbBTC (permit) or a smart account is preferable on Base.
 */
export function createEoaWallet({ account, walletClient, publicClient }: EoaWalletOptions): L402Wallet {
  const address = getAddress(account.address);
  return {
    address,
    signerAddress: address,

    async signVoucher(chainId, escrow, voucher) {
      const typedData = voucherTypedData(chainId, escrow, voucher);
      return walletClient.signTypedData({ account, ...typedData });
    },

    async sendCalls(calls) {
      let last: Hex = "0x";
      for (const call of calls) {
        last = await walletClient.sendTransaction({
          account,
          chain: walletClient.chain ?? null,
          to: call.to,
          data: call.data,
          ...(call.value !== undefined ? { value: call.value } : {}),
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: last });
        // Stop at the first failure: later calls (e.g. openChannel after approve) depend on it.
        if (receipt.status !== "success") throw new Error(`Transaction reverted: ${last}`);
      }
      return last;
    },
  };
}

/**
 * Minimal ERC-4337 client required: any object able to sign typed data and send
 * a batch of calls. Both viem/account-abstraction's `bundlerClient` and
 * permissionless.js's `SmartAccountClient` fit.
 */
export interface SmartAccountLike {
  account: { address: Address };
  signTypedData(args: Record<string, unknown>): Promise<Hex>;
  sendUserOperation(args: {
    calls: { to: Address; data: Hex; value?: bigint }[];
  }): Promise<Hex>;
  waitForUserOperationReceipt(args: { hash: Hex }): Promise<{ success?: boolean; receipt: { transactionHash: Hex } }>;
}

/**
 * Wallet backed by an ERC-4337 smart account.
 *
 * Two concrete benefits for an AI agent:
 *  - atomic batching: `approve` + `openChannel` in one UserOperation, so even
 *    tokens without permit (WBTC) need a single confirmation;
 *  - vouchers are signed by the smart account and verified via ERC-1271, so the
 *    agent's key can be rotated without touching the channel.
 */
export function createSmartAccountWallet(client: SmartAccountLike): L402Wallet {
  const address = getAddress(client.account.address);
  return {
    address,
    signerAddress: address,

    async signVoucher(chainId, escrow, voucher) {
      return client.signTypedData(voucherTypedData(chainId, escrow, voucher) as unknown as Record<string, unknown>);
    },

    async sendCalls(calls) {
      const hash = await client.sendUserOperation({ calls });
      const { success, receipt } = await client.waitForUserOperationReceipt({ hash });
      if (success === false) throw new Error(`UserOperation failed: ${hash}`);
      return receipt.transactionHash;
    },
  };
}

export interface SessionKeyWalletOptions {
  /** Owner wallet (a human, or the agent's smart account). */
  owner: L402Wallet;
  /** Session private key. A fresh one is generated when absent. */
  privateKey?: Hex;
}

export interface SessionKeyWallet extends L402Wallet {
  /** Session private key: keep it in memory, never on disk. */
  readonly privateKey: Hex;
  /**
   * Registers the delegation on-chain: "this key may sign vouchers for me up to
   * `maxCumulative`, until `validUntil`". A live delegation can only be widened.
   */
  authorize(escrow: Address, maxCumulative: bigint, validUntil: bigint): Promise<Hex>;
  /** Revokes the key. It stays usable for 24h so providers can settle what they were paid. */
  revoke(escrow: Address): Promise<Hex>;
}

/**
 * Session key: the operational form of "I allow the agent to spend up to X
 * without asking me".
 *
 * The key signs vouchers instead of the owner, but the spending cap is enforced
 * by the smart contract, not by client code: even if the key leaks, the loss is
 * bounded by `maxCumulative` per channel (the cap applies to the cumulative
 * amount of each channel of the owner).
 */
export function createSessionKeyWallet(options: SessionKeyWalletOptions): SessionKeyWallet {
  const privateKey = options.privateKey ?? generatePrivateKey();
  const sessionAccount = privateKeyToAccount(privateKey);
  const owner = options.owner;

  return {
    privateKey,
    address: owner.address,
    signerAddress: getAddress(sessionAccount.address),

    async signVoucher(chainId, escrow, voucher) {
      return sessionAccount.signTypedData(voucherTypedData(chainId, escrow, voucher));
    },

    sendCalls: owner.sendCalls.bind(owner),

    async authorize(escrow, maxCumulative, validUntil) {
      return owner.sendCalls([
        {
          to: escrow,
          data: encodeFunctionData({
            abi: escrowAbi,
            functionName: "authorizeSigner",
            args: [sessionAccount.address, maxCumulative, validUntil],
          }),
        },
      ]);
    },

    async revoke(escrow) {
      return owner.sendCalls([
        {
          to: escrow,
          data: encodeFunctionData({
            abi: escrowAbi,
            functionName: "revokeSigner",
            args: [sessionAccount.address],
          }),
        },
      ]);
    },
  };
}

/**
 * Delegation signed off-chain: the human signs, the agent (or a relayer) pays the
 * gas. Useful when the owner is a hardware wallet that should not stay online.
 */
export async function signDelegation(
  signer: { signTypedData(args: Record<string, unknown>): Promise<Hex> },
  chainId: number,
  escrow: Address,
  delegation: { payer: Address; signer: Address; maxCumulative: bigint; validUntil: bigint; nonce: bigint },
): Promise<Hex> {
  return signer.signTypedData(
    delegationTypedData(chainId, escrow, delegation) as unknown as Record<string, unknown>,
  );
}

/** `approve` calldata for the token, to batch with `openChannel`. */
export function approveCall(token: Address, spender: Address, amount: bigint = maxUint256) {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  };
}
