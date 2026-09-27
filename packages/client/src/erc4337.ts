import { createPublicClient, http, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createBundlerClient, toCoinbaseSmartAccount, type BundlerClientConfig } from "viem/account-abstraction";
import { createSmartAccountWallet, type L402Wallet, type SmartAccountLike } from "./wallet.js";

export interface SmartAccountOptions {
  chain: Chain;
  /** L2 RPC endpoint. */
  rpcUrl?: string;
  /** ERC-4337 bundler endpoint (Pimlico, Alchemy, Coinbase, ...). */
  bundlerUrl: string;
  /** Owner key of the smart account. Can live in a KMS. */
  ownerPrivateKey: Hex;
  /**
   * Optional paymaster, to have someone else pay the gas: `true` uses the
   * bundler's own paymaster, or pass a paymaster client from viem.
   */
  paymaster?: BundlerClientConfig["paymaster"];
  publicClient?: PublicClient;
}

/**
 * Ready-to-use ERC-4337 smart account (Coinbase Smart Wallet, native on Base).
 *
 * In this protocol it serves two purposes:
 *  - running `approve` + `openChannel` in a single atomic UserOperation;
 *  - having vouchers verified via ERC-1271, so session keys can be rotated
 *    without ever moving the channel funds.
 */
export async function createBaseSmartAccountWallet(options: SmartAccountOptions): Promise<{
  wallet: L402Wallet;
  address: Address;
  publicClient: PublicClient;
}> {
  const publicClient =
    options.publicClient ??
    (createPublicClient({ chain: options.chain, transport: http(options.rpcUrl) }) as PublicClient);

  const owner = privateKeyToAccount(options.ownerPrivateKey);
  const account = await toCoinbaseSmartAccount({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: publicClient as any,
    owners: [owner],
    version: "1.1",
  });

  const bundlerClient = createBundlerClient({
    account,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: publicClient as any,
    transport: http(options.bundlerUrl),
    chain: options.chain,
    ...(options.paymaster ? { paymaster: options.paymaster } : {}),
  });

  const adapter: SmartAccountLike = {
    account: { address: account.address },
    signTypedData: (args) => account.signTypedData(args as never),
    sendUserOperation: (args) => bundlerClient.sendUserOperation(args as never),
    waitForUserOperationReceipt: (args) =>
      bundlerClient.waitForUserOperationReceipt(args) as unknown as Promise<{
        success?: boolean;
        receipt: { transactionHash: Hex };
      }>,
  };

  return {
    wallet: createSmartAccountWallet(adapter),
    address: account.address,
    publicClient,
  };
}
