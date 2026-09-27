/**
 * Paid MCP server, ready for Base (or any EVM L2).
 *
 *   cp .env.example .env   # fill in the values
 *   npm run example:server
 *
 * Exposes three paid tools and the discovery document at
 * http://localhost:3402/.well-known/l402
 */
import { createPublicClient, http, getAddress, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getChain, formatUnits } from "@l402-el2/core";
import {
  Gatekeeper,
  MemoryVoucherStore,
  RedisVoucherStore,
  createMcpL402App,
  type VoucherStore,
} from "@l402-el2/server";

try {
  process.loadEnvFile?.(); // loads ./.env when present
} catch {
  // no .env file: rely on the real environment
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value === "0x") throw new Error(`Missing environment variable: ${name}. Copy .env.example to .env.`);
  return value;
}

/** Price list in token base units (satoshis for cbBTC: 1 sat ≈ $0.001 at $100k/BTC). */
const PRICING = {
  default: 100n,
  resources: {
    search_web: 250n,
    summarize: 500n,
    heavy_analysis: 5_000n,
  },
};

async function buildStore(): Promise<VoucherStore> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn(
      "⚠️  REDIS_URL is not set: using the in-memory store.\n" +
        "   Fine for development, but vouchers are lost on restart, it does not\n" +
        "   work with several server instances, and the settler (a separate\n" +
        "   process) cannot see them: use Redis in production.",
    );
    return new MemoryVoucherStore();
  }
  const ioredis = (await import("ioredis")) as unknown as {
    default: new (url: string) => unknown;
    Redis?: new (url: string) => unknown;
  };
  const Redis = ioredis.Redis ?? ioredis.default;
  return new RedisVoucherStore(new Redis(url) as never, process.env.REDIS_PREFIX || "l402");
}

async function main() {
  const chain = getChain(Number(process.env.CHAIN_ID || 8453));
  const providerAccount = privateKeyToAccount(required("PROVIDER_PRIVATE_KEY") as `0x${string}`);
  const tokenDecimals = Number(process.env.TOKEN_DECIMALS || 8);
  const tokenSymbol = process.env.TOKEN_SYMBOL || "cbBTC";

  const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL || undefined) }) as PublicClient;

  const gatekeeper = new Gatekeeper({
    service: process.env.SERVICE_NAME || "mcp.example.com",
    // In production: read it from a secret manager, not from a file.
    rootKey: Buffer.from(required("MACAROON_ROOT_KEY"), "hex"),
    provider: getAddress(providerAccount.address),
    chainId: chain.id,
    escrow: required("ESCROW_ADDRESS") as `0x${string}`,
    token: required("TOKEN_ADDRESS") as `0x${string}`,
    tokenSymbol,
    tokenDecimals,
    publicClient,
    store: await buildStore(),
    pricing: PRICING,
    macaroonTtl: 3600,
    voucherTtl: 86_400, // vouchers must outlive the settler interval (see minVoucherTimeLeft)
    minDeposit: 100_000n, // 0.001 cbBTC: about 400 calls to search_web
  });

  const app = createMcpL402App({
    gatekeeper,
    onPayment: ({ payer, resource, price }) => {
      console.log(`💰 ${payer.slice(0, 10)}… paid ${formatUnits(price, tokenDecimals)} ${tokenSymbol} for ${resource}`);
    },
    createServer: () => {
      const server = new McpServer({ name: "paid-mcp-example", version: "0.1.0" });

      server.registerTool(
        "search_web",
        {
          description: `Searches the web. Cost: ${formatUnits(PRICING.resources.search_web, tokenDecimals)} ${tokenSymbol}.`,
          inputSchema: { query: z.string().describe("Search terms") },
        },
        async ({ query }) => ({
          content: [{ type: "text", text: `Results for "${query}" (plug the real search in here).` }],
        }),
      );

      server.registerTool(
        "summarize",
        {
          description: `Summarizes a text. Cost: ${formatUnits(PRICING.resources.summarize, tokenDecimals)} ${tokenSymbol}.`,
          inputSchema: { text: z.string() },
        },
        async ({ text }) => ({
          content: [{ type: "text", text: `Summary of ${text.length} characters (plug the real model in here).` }],
        }),
      );

      server.registerTool(
        "heavy_analysis",
        {
          description: `Expensive analysis. Cost: ${formatUnits(PRICING.resources.heavy_analysis, tokenDecimals)} ${tokenSymbol}.`,
          inputSchema: { dataset: z.string() },
        },
        async ({ dataset }) => ({
          content: [{ type: "text", text: `Analysis of ${dataset} completed.` }],
        }),
      );

      return server;
    },
  });

  const port = Number(process.env.PORT || 3402);
  app.listen(port, () => {
    console.log(`\n🚪 L402-EL2 MCP server listening on http://localhost:${port}`);
    console.log(`   MCP endpoint:  http://localhost:${port}/mcp`);
    console.log(`   discovery:     http://localhost:${port}/.well-known/l402`);
    console.log(`   chain:         ${chain.name} (${chain.id})`);
    console.log(`   payments to:   ${providerAccount.address}`);
    console.log(`\n   Remember to run the settler to collect: npx l402-settler loop\n`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
