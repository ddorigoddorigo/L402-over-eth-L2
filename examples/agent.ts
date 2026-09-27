/**
 * AI agent that pays for MCP tools on its own.
 *
 *   npm run example:agent
 *
 * Shows the complete path: ERC-4337 smart account, session key with a spending
 * cap enforced on-chain, channel opening in a batch transaction and MCP calls
 * paid off-chain at zero cost.
 */
import { createPublicClient, createWalletClient, http, getAddress, type PublicClient } from "viem";
import { getChain, formatUnits, parseUnits } from "@l402-el2/core";
import {
  ChannelManager,
  connectPaidMcpClient,
  createBaseSmartAccountWallet,
  createEoaWallet,
  createSessionKeyWallet,
  discoverL402Service,
  PaymentRefused,
  type L402Wallet,
} from "@l402-el2/client";
import { privateKeyToAccount } from "viem/accounts";

try {
  process.loadEnvFile?.(); // loads ./.env when present
} catch {
  // no .env file: rely on the real environment
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value === "0x") throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function main() {
  const serverUrl = process.env.MCP_SERVER_URL || "http://localhost:3402";
  const chain = getChain(Number(process.env.CHAIN_ID || 8453));
  const transport = http(process.env.RPC_URL || undefined);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;

  /* ------------------------- 1. Discover the service ----------------------- */

  const service = await discoverL402Service(serverUrl);
  console.log(`Service: ${service.service} on chain ${service.chainId}`);
  console.log(`Token: ${service.tokenSymbol} (${service.token})`);
  console.log(`Prices:`);
  for (const [tool, price] of Object.entries(service.pricing.resources)) {
    console.log(`  ${tool.padEnd(16)} ${formatUnits(BigInt(price), service.tokenDecimals)} ${service.tokenSymbol}`);
  }

  /* --------------------------- 2. Agent wallet ----------------------------- */

  // With a bundler configured the agent uses an ERC-4337 smart account:
  // `approve` + `openChannel` travel in a single atomic UserOperation.
  // Without a bundler it falls back to an EOA (two separate transactions).
  let ownerWallet: L402Wallet;

  if (process.env.BUNDLER_URL) {
    const smart = await createBaseSmartAccountWallet({
      chain,
      bundlerUrl: process.env.BUNDLER_URL,
      ownerPrivateKey: required("AGENT_PRIVATE_KEY") as `0x${string}`,
      ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
      publicClient,
    });
    ownerWallet = smart.wallet;
    console.log(`\nSmart account ERC-4337: ${smart.address}`);
  } else {
    const account = privateKeyToAccount(required("AGENT_PRIVATE_KEY") as `0x${string}`);
    ownerWallet = createEoaWallet({
      account,
      walletClient: createWalletClient({ account, chain, transport }),
      publicClient,
    });
    console.log(`\nEOA (no BUNDLER_URL configured): ${ownerWallet.address}`);
  }

  /* ----------------------- 3. Open the channel ---------------------------- */

  // The session key signs for the owner, but every on-chain call it makes
  // (opening, topping up) is sent by the owner wallet.
  const sessionWallet = createSessionKeyWallet({ owner: ownerWallet });
  const channels = new ChannelManager({
    wallet: sessionWallet,
    publicClient,
    chainId: chain.id,
    escrow: service.escrow,
    token: service.token,
  });

  const provider = getAddress(service.provider);
  const existing = await channels.snapshot(provider);
  const deposit = BigInt(service.minDeposit);

  if (!existing.exists || existing.available < deposit / 10n) {
    console.log(`\nOpening the channel with ${formatUnits(deposit, service.tokenDecimals)} ${service.tokenSymbol}…`);
    const hash = await channels.open(provider, deposit);
    console.log(`  tx: ${hash}`);
  } else {
    console.log(`\nChannel already active: ${formatUnits(existing.available, service.tokenDecimals)} ${service.tokenSymbol} available`);
    await channels.syncCumulative(provider);
  }

  /* ---------------------- 4. Capped session key --------------------------- */

  // The on-chain cap applies to the channel's CUMULATIVE counter, not to what
  // this key spends: it must sit `dailyCap` above where the counter is today,
  // otherwise a channel that already spent `dailyCap` in earlier runs could
  // never be paid again.
  const dailyCap = parseUnits(process.env.DAILY_CAP || "0.0005", service.tokenDecimals);
  const keyCap = channels.getCumulative(provider) + dailyCap;
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 86_400);

  console.log(`Session key ${sessionWallet.signerAddress}`);
  console.log(
    `  may spend ${formatUnits(dailyCap, service.tokenDecimals)} ${service.tokenSymbol} more ` +
      `(cumulative cap ${formatUnits(keyCap, service.tokenDecimals)}, enforced by the smart contract)`,
  );
  await sessionWallet.authorize(service.escrow, keyCap, validUntil);

  /* --------------------------- 5. Use the paid tools ----------------------- */

  let spent = 0n;
  const client = await connectPaidMcpClient({
    url: `${serverUrl}/mcp`,
    channels,
    policy: {
      // Two lines of defence: these limits apply client-side, the session key cap
      // applies on-chain. The first avoids signing, the second avoids paying.
      maxPricePerCall: parseUnits(process.env.MAX_PRICE_PER_CALL || "0.0001", service.tokenDecimals),
      totalBudget: dailyCap,
      allowedProviders: [provider],
      allowedEscrows: [service.escrow],
      allowedChainIds: [chain.id],
    },
    autoTopUp: { amount: deposit, maxTimes: 1 },
    onPayment: ({ amount }) => {
      spent += amount;
    },
  });

  const { tools } = await client.listTools();
  console.log(`\nAvailable tools: ${tools.map((t) => t.name).join(", ")}`);

  for (const query of ["state of ethereum layer 2", "cbBTC adoption"]) {
    const started = Date.now();
    const result = await client.callTool({ name: "search_web", arguments: { query } });
    const text = (result.content as { text?: string }[])[0]?.text ?? "";
    console.log(`  search_web("${query}") in ${Date.now() - started}ms → ${text.slice(0, 60)}…`);
  }

  try {
    await client.callTool({ name: "heavy_analysis", arguments: { dataset: "btc-flows" } });
  } catch (error) {
    if (error instanceof PaymentRefused) {
      console.log(`  heavy_analysis refused by the policy: ${error.message}`);
    } else {
      throw error;
    }
  }

  console.log(`\nTotal spent: ${formatUnits(spent, service.tokenDecimals)} ${service.tokenSymbol}`);
  console.log(`On-chain transactions for the calls: 0 (local signatures only)`);

  const final = await channels.snapshot(provider);
  console.log(`Left in the channel: ${formatUnits(final.available, service.tokenDecimals)} ${service.tokenSymbol}`);

  await client.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
