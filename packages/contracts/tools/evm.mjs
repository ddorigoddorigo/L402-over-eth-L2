/**
 * In-process EVM node (EDR, the same engine as Hardhat Network) exposed through
 * viem clients. Lets you test the escrow without anvil/forge installed.
 *
 * Used by `tools/escrow.test.mjs`, the server tests and `examples/e2e.ts`. With
 * Foundry, `forge test` covers the same cases in Solidity (`test/L402Escrow.t.sol`).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, createPublicClient, custom } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { hardhat as hardhatChain } from "viem/chains";

const require = createRequire(import.meta.url);
const { createHardhatNetworkProvider } = require("hardhat/internal/hardhat-network/provider/provider");
const defaults = require("hardhat/internal/core/config/default-config");

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = resolve(HERE, "../artifacts");

export const MNEMONIC = "test test test test test test test test test test test junk";
export const CHAIN_ID = 84532; // Base Sepolia, so the EIP-712 domain in tests is realistic

export function loadArtifact(name) {
  return JSON.parse(readFileSync(join(ARTIFACTS, `${name}.json`), "utf8"));
}

export function testAccounts(count = 10) {
  return Array.from({ length: count }, (_, i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
}

export async function startEvm({ chainId = CHAIN_ID, accountCount = 10 } = {}) {
  const accounts = testAccounts(accountCount);
  const genesisAccounts = accounts.map((a) => ({
    privateKey: a.getHdKey().privateKey ? `0x${Buffer.from(a.getHdKey().privateKey).toString("hex")}` : undefined,
    balance: 10n ** 24n,
  }));

  const provider = await createHardhatNetworkProvider(
    {
      hardfork: "cancun",
      chainId,
      networkId: chainId,
      blockGasLimit: 30_000_000n,
      minGasPrice: 0n,
      initialBaseFeePerGas: 0,
      automine: true,
      intervalMining: 0,
      mempoolOrder: "priority",
      chains: defaults.defaultHardhatNetworkParams.chains,
      genesisAccounts,
      allowUnlimitedContractSize: false,
      throwOnTransactionFailures: true,
      throwOnCallFailures: true,
      allowBlocksWithSameTimestamp: false,
      enableTransientStorage: true,
      enableRip7212: false,
      coinbase: "0xc014ba5ec014ba5ec014ba5ec014ba5ec014ba5e",
      initialDate: new Date(),
    },
    { enabled: false, printLineFn() {}, replaceLastLineFn() {} },
  );

  const chain = { ...hardhatChain, id: chainId };
  const transport = custom({ request: (args) => provider.request(args) });
  const publicClient = createPublicClient({ chain, transport });

  const wallets = accounts.map((account) => createWalletClient({ account, chain, transport }));

  return {
    provider,
    chain,
    publicClient,
    accounts,
    wallets,
    /** Moves chain time forward by `seconds` and mines a block. */
    async increaseTime(seconds) {
      await provider.request({ method: "evm_increaseTime", params: [Number(seconds)] });
      await provider.request({ method: "evm_mine", params: [] });
    },
    async deploy(name, args = [], walletIndex = 0) {
      const artifact = loadArtifact(name);
      const hash = await wallets[walletIndex].deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode,
        args,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return { address: receipt.contractAddress, abi: artifact.abi, receipt };
    },
  };
}
