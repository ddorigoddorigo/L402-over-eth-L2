import type { Abi, Address, Chain, Hex, PublicClient, WalletClient } from "viem";
import type { HDAccount } from "viem/accounts";

export declare const MNEMONIC: string;
export declare const CHAIN_ID: number;

export interface DeployedContract {
  address: Address;
  abi: Abi;
  receipt: { contractAddress: Address; transactionHash: Hex };
}

export interface TestEvm {
  provider: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
  chain: Chain;
  publicClient: PublicClient;
  accounts: HDAccount[];
  wallets: WalletClient[];
  increaseTime(seconds: number): Promise<void>;
  deploy(name: string, args?: unknown[], walletIndex?: number): Promise<DeployedContract>;
}

export declare function loadArtifact(name: string): { abi: Abi; bytecode: Hex; deployedBytecode: Hex };
export declare function testAccounts(count?: number): HDAccount[];
export declare function startEvm(options?: { chainId?: number; accountCount?: number }): Promise<TestEvm>;
