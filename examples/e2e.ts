/**
 * End-to-end run of the L402-EL2 protocol, with no external dependencies.
 *
 *   npm run example:e2e
 *
 * What happens:
 *   1. an in-process EVM starts and MockBTC (a fake cbBTC) and L402Escrow are deployed;
 *   2. an MCP server with two paid tools starts;
 *   3. an AI agent opens a channel, authorizes a session key and calls the tools;
 *   4. every call is paid with an off-chain EIP-712 signature (zero gas);
 *   5. the agent restarts and re-synchronizes from the server's last voucher;
 *   6. the settler collects everything in a single L2 transaction.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { createWalletClient, custom, getAddress, type Address, type PublicClient } from "viem";
import { z } from "zod";

import { startEvm } from "../packages/contracts/tools/evm.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Gatekeeper, MemoryVoucherStore, createMcpL402App, priceFor } from "@l402-el2/server";
import {
  ChannelManager,
  connectPaidMcpClient,
  createEoaWallet,
  createSessionKeyWallet,
  discoverL402Service,
} from "@l402-el2/client";
import { Settler } from "@l402-el2/settler";
import { formatUnits } from "@l402-el2/core";

const SATS = (n: number) => BigInt(n);
const TOKEN_DECIMALS = 8;
const TOKEN_SYMBOL = "cbBTC";

const PRICING = {
  default: SATS(100), // 0.000001 cbBTC
  resources: {
    search_web: SATS(250),
    heavy_analysis: SATS(2_000),
  },
} as const;

function log(step: string, detail = "") {
  console.log(`\x1b[36m${step}\x1b[0m ${detail}`);
}

function amount(value: bigint) {
  return `${formatUnits(value, TOKEN_DECIMALS)} ${TOKEN_SYMBOL}`;
}

async function listen(app: ReturnType<typeof createMcpL402App>): Promise<{ server: Server; url: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port assigned");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function main() {
  /* ------------------------- 1. Chain and contracts ------------------------ */

  const evm = await startEvm();
  const [deployer, providerAccount, agentAccount] = evm.accounts;
  if (!deployer || !providerAccount || !agentAccount) throw new Error("missing test accounts");

  const token = await evm.deploy("MockBTC");
  const escrow = await evm.deploy("L402Escrow", [deployer.address, deployer.address, 0]);
  log("1. contracts", `escrow=${escrow.address} token=${token.address}`);

  const publicClient = evm.publicClient as PublicClient;
  const transport = custom({ request: (args) => evm.provider.request(args) as Promise<unknown> });

  // The agent receives 1 fake cbBTC to spend
  const mintHash = await evm.wallets[0]!.writeContract({
    address: token.address,
    abi: token.abi,
    functionName: "mint",
    args: [agentAccount.address, SATS(100_000_000)],
    account: deployer,
    chain: evm.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  /* --------------------------- 2. MCP server ------------------------------ */

  const store = new MemoryVoucherStore();
  const gatekeeper = new Gatekeeper({
    service: "mcp.example.l402",
    rootKey: randomBytes(32),
    provider: getAddress(providerAccount.address),
    chainId: evm.chain.id,
    escrow: escrow.address,
    token: token.address,
    tokenSymbol: TOKEN_SYMBOL,
    tokenDecimals: TOKEN_DECIMALS,
    publicClient,
    store,
    pricing: PRICING,
    minChannelTimeLeft: 60,
  });

  const payments: { payer: string; resource: string; price: bigint }[] = [];

  const app = createMcpL402App({
    gatekeeper,
    priceOf: (resource) => priceFor(PRICING, resource),
    onPayment: (info) => payments.push(info),
    createServer: () => {
      const server = new McpServer({ name: "demo-paid-mcp", version: "0.1.0" });

      server.registerTool(
        "search_web",
        {
          description: `Web search. Cost: ${amount(PRICING.resources.search_web)} per call.`,
          inputSchema: { query: z.string() },
        },
        async ({ query }) => ({
          content: [{ type: "text", text: `Results for "${query}": [3 documents found]` }],
        }),
      );

      server.registerTool(
        "heavy_analysis",
        {
          description: `Expensive analysis. Cost: ${amount(PRICING.resources.heavy_analysis)} per call.`,
          inputSchema: { dataset: z.string() },
        },
        async ({ dataset }) => ({
          content: [{ type: "text", text: `Analysis of ${dataset} completed.` }],
        }),
      );

      return server;
    },
  });

  const { server, url } = await listen(app);
  log("2. MCP server", url);

  /* ------------------------ 3. Discovery and channel ---------------------- */

  const discovery = await discoverL402Service(url);
  log("3. discovery", `${discovery.service} — default ${amount(BigInt(discovery.pricing.default))}`);
  assert.equal(getAddress(discovery.provider), getAddress(providerAccount.address));

  const agentWalletClient = createWalletClient({ account: agentAccount, chain: evm.chain, transport });
  const ownerWallet = createEoaWallet({
    account: agentAccount,
    walletClient: agentWalletClient,
    publicClient,
  });

  // Session key: the agent signs with a throwaway key, capped on-chain.
  const sessionWallet = createSessionKeyWallet({ owner: ownerWallet });
  const sessionCap = SATS(50_000);
  await sessionWallet.authorize(
    escrow.address,
    sessionCap,
    BigInt(Math.floor(Date.now() / 1000) + 86_400),
  );
  log("   session key", `${sessionWallet.signerAddress} capped at ${amount(sessionCap)}`);

  const channels = new ChannelManager({
    wallet: sessionWallet,
    publicClient,
    chainId: evm.chain.id,
    escrow: escrow.address,
    token: token.address,
  });

  const deposit = SATS(1_000_000); // 0.01 cbBTC
  await channels.open(getAddress(providerAccount.address), deposit);
  const opened = await channels.snapshot(getAddress(providerAccount.address));
  log("   channel open", `${amount(opened.deposited)} deposited, id ${opened.channelId.slice(0, 12)}…`);
  assert.equal(opened.deposited, deposit);

  /* ------------------------- 4. Paid MCP calls ----------------------------- */

  const spentByAgent: bigint[] = [];
  const client = await connectPaidMcpClient({
    url: `${url}/mcp`,
    channels,
    policy: {
      maxPricePerCall: SATS(5_000),
      totalBudget: SATS(100_000),
      allowedProviders: [getAddress(providerAccount.address)],
      allowedEscrows: [escrow.address],
      allowedChainIds: [evm.chain.id],
    },
    onPayment: (info) => spentByAgent.push(info.amount),
  });

  const tools = await client.listTools();
  log("4. tools/list", `${tools.tools.map((t) => t.name).join(", ")} (free)`);
  assert.equal(payments.length, 0, "tools/list must not cost anything");

  const started = Date.now();
  for (const query of ["ethereum layer 2", "wrapped btc", "model context protocol"]) {
    const result = await client.callTool({ name: "search_web", arguments: { query } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    log("   search_web", `"${query}" -> ${text.slice(0, 45)}…`);
  }
  await client.callTool({ name: "heavy_analysis", arguments: { dataset: "prezzi-btc-2026" } });
  log("   heavy_analysis", "done");

  const elapsed = Date.now() - started;
  const expected = PRICING.resources.search_web * 3n + PRICING.resources.heavy_analysis;
  const totalPaid = spentByAgent.reduce((a, b) => a + b, 0n);

  log(
    "   total paid",
    `${amount(totalPaid)} for 4 calls, ${elapsed}ms overall, 0 on-chain transactions`,
  );
  assert.equal(payments.length, 4, "the server must have recorded 4 payments");
  assert.equal(totalPaid, expected, `expected ${expected}, paid ${totalPaid}`);

  const channelId = channels.channelId(getAddress(providerAccount.address));
  const lastVoucher = await store.get(channelId);
  assert.ok(lastVoucher, "the server must keep the latest voucher");
  assert.equal(BigInt(lastVoucher.cumulativeAmount), expected);
  assert.equal(getAddress(lastVoucher.signer!), sessionWallet.signerAddress);
  log("   latest voucher", `cumulative ${amount(BigInt(lastVoucher.cumulativeAmount))}, nonce ${lastVoucher.nonce}`);

  /* ------------------ 4b. The agent restarts before settlement ------------ */

  // A new process: fresh session key, fresh ChannelManager whose counter only
  // knows the on-chain floor (0: nothing settled yet). The server still holds the
  // 0.0000275 voucher; the client verifies it (signed by a key the payer
  // delegated) and continues from there instead of refusing to pay.
  const restartedSession = createSessionKeyWallet({ owner: ownerWallet });
  await restartedSession.authorize(escrow.address, sessionCap, BigInt(Math.floor(Date.now() / 1000) + 86_400));
  const restartedChannels = new ChannelManager({
    wallet: restartedSession,
    publicClient,
    chainId: evm.chain.id,
    escrow: escrow.address,
    token: token.address,
  });
  await restartedChannels.syncCumulative(getAddress(providerAccount.address));
  const paidAfterRestart: bigint[] = [];
  const restartedClient = await connectPaidMcpClient({
    url: `${url}/mcp`,
    channels: restartedChannels,
    policy: { maxPricePerCall: SATS(5_000), totalBudget: SATS(1_000) },
    onPayment: (info) => paidAfterRestart.push(info.amount),
  });
  await restartedClient.callTool({ name: "search_web", arguments: { query: "after restart" } });
  assert.deepEqual(paidAfterRestart, [PRICING.resources.search_web], "only the new call is paid after a restart");
  log("4b. restart", `new session key, re-synchronized from the server's last voucher, paid ${amount(paidAfterRestart[0]!)}`);
  const expectedAfterRestart = expected + PRICING.resources.search_web;

  /* ----------------------- 5. Refusal above the budget -------------------- */

  const stingyClient = await connectPaidMcpClient({
    url: `${url}/mcp`,
    channels,
    policy: { maxPricePerCall: SATS(10), totalBudget: SATS(1_000) },
  });
  await assert.rejects(
    () => stingyClient.callTool({ name: "heavy_analysis", arguments: { dataset: "x" } }),
    /exceeds the per-call maximum|PaymentRefused/,
    "the client spending policy must block the overpriced call",
  );
  log("5. policy", "overpriced call refused by the client before signing");

  /* --------------------------- 6. Settlement ------------------------------ */

  const providerWalletClient = createWalletClient({
    account: providerAccount,
    chain: evm.chain,
    transport,
  });
  const settler = new Settler({
    store,
    publicClient,
    walletClient: providerWalletClient,
    account: providerAccount,
    escrow: escrow.address,
    tokenDecimals: TOKEN_DECIMALS,
    tokenSymbol: TOKEN_SYMBOL,
    minSettleAmount: SATS(1),
  });

  const balanceBefore = (await publicClient.readContract({
    address: token.address,
    abi: token.abi,
    functionName: "balanceOf",
    args: [providerAccount.address],
  })) as bigint;

  const settlement = await settler.settle();
  assert.ok(settlement, "the settler must have collected");

  const balanceAfter = (await publicClient.readContract({
    address: token.address,
    abi: token.abi,
    functionName: "balanceOf",
    args: [providerAccount.address],
  })) as bigint;

  log("6. settlement", `1 L2 transaction for ${amount(balanceAfter - balanceBefore)} — tx ${settlement.txHash.slice(0, 12)}…`);
  assert.equal(balanceAfter - balanceBefore, expectedAfterRestart, "the provider must receive exactly the signed cumulative amount");

  // A second run must not collect the same amount twice
  assert.equal(await settler.settle(), undefined, "no double settlement");
  log("   double settlement", "correctly refused");

  /* ------------------------ 7. Remainder for the payer -------------------- */

  const after = await channels.snapshot(getAddress(providerAccount.address));
  assert.equal(after.claimed, expectedAfterRestart);
  assert.equal(after.available, deposit - expectedAfterRestart);
  log("7. channel", `${amount(after.available)} still available for the next calls`);

  await client.close();
  await stingyClient.close();
  await restartedClient.close();
  server.close();

  console.log(
    `\n\x1b[32m✅ End-to-end complete.\x1b[0m 5 MCP calls paid off-chain (across a restart), a single settlement transaction.`,
  );
  console.log(
    `   Gas cost of a purely on-chain model: 5 transactions. With L402-EL2: 1 channel opening + 1 settlement.`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("\n❌ E2E failed:", error);
  process.exit(1);
});
