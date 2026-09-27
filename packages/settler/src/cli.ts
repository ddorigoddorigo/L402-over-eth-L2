#!/usr/bin/env node
/**
 * Settler CLI.
 *
 *   l402-settler plan     shows what would be settled, without sending anything
 *   l402-settler once     runs one settlement and exits
 *   l402-settler loop     keeps running and settles at a regular interval
 *
 * Configured through environment variables (see .env.example). A `.env` file in
 * the current directory is loaded automatically when present.
 */
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain } from "@l402-el2/core";
import { MemoryVoucherStore, RedisVoucherStore, type VoucherStore } from "@l402-el2/server";
import { Settler, startSettlerLoop } from "./settler.js";

try {
  process.loadEnvFile?.();
} catch {
  // no .env file: rely on the real environment
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value === "0x") throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function buildStore(): Promise<VoucherStore> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn("[settler] REDIS_URL is not set: using an in-memory store (no vouchers to settle).");
    return new MemoryVoucherStore();
  }
  // Dynamic import: ioredis is an optional dependency, not needed by memory-store users.
  const ioredis = (await import("ioredis")) as unknown as {
    default: new (url: string) => unknown;
    Redis?: new (url: string) => unknown;
  };
  const Redis = ioredis.Redis ?? ioredis.default;
  return new RedisVoucherStore(new Redis(url) as never, process.env.REDIS_PREFIX ?? "l402");
}

async function main() {
  const command = process.argv[2] ?? "plan";
  const chain = getChain(Number(required("CHAIN_ID")));
  const account = privateKeyToAccount(required("PROVIDER_PRIVATE_KEY") as `0x${string}`);
  const transport = http(process.env.RPC_URL || undefined);

  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const walletClient = createWalletClient({ account, chain, transport });

  const store = await buildStore();
  const settler = new Settler({
    store,
    publicClient,
    walletClient,
    account,
    escrow: required("ESCROW_ADDRESS") as `0x${string}`,
    tokenDecimals: Number(process.env.TOKEN_DECIMALS || 8),
    tokenSymbol: process.env.TOKEN_SYMBOL || "cbBTC",
    minSettleAmount: BigInt(process.env.MIN_SETTLE_AMOUNT || 10_000),
    batchSize: Number(process.env.SETTLE_BATCH_SIZE || 50),
    ...(process.env.SETTLE_EXPIRY_BUFFER ? { expiryBuffer: Number(process.env.SETTLE_EXPIRY_BUFFER) } : {}),
  });

  switch (command) {
    case "plan":
      console.log(await settler.describe());
      break;

    case "once": {
      const result = await settler.settle();
      console.log(result ? `Settled ${result.settled} channels — tx ${result.txHash}` : "Nothing to settle.");
      break;
    }

    case "loop": {
      const intervalMs = Number(process.env.SETTLE_INTERVAL_MS || 3_600_000);
      console.log(`[settler] started on ${chain.name}, settling every ${intervalMs / 1000}s`);
      const stop = startSettlerLoop(settler, intervalMs);
      const shutdown = async () => {
        stop();
        await store.close?.();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      await new Promise(() => {}); // keep running
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Use plan | once | loop.`);
      process.exit(1);
  }
  await store.close?.();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
