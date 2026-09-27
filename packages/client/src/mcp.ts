import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChannelManager } from "./channel.js";
import { createL402Fetch, type SpendingPolicy } from "./fetch.js";

export interface L402McpClientOptions {
  url: string | URL;
  channels: ChannelManager;
  policy: SpendingPolicy;
  clientInfo?: { name: string; version: string };
  autoTopUp?: { amount: bigint; maxTimes?: number };
  onPayment?: Parameters<typeof createL402Fetch>[0]["onPayment"];
}

/**
 * MCP client that pays on its own.
 *
 * Payment is injected into the transport's `fetch`: the agent calls
 * `client.callTool(...)` as if the server were free, and the 402 is intercepted,
 * paid and retried under the hood.
 */
export async function connectPaidMcpClient(options: L402McpClientOptions): Promise<Client> {
  const l402Fetch = createL402Fetch({
    channels: options.channels,
    policy: options.policy,
    ...(options.autoTopUp ? { autoTopUp: options.autoTopUp } : {}),
    ...(options.onPayment ? { onPayment: options.onPayment } : {}),
  });

  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    fetch: l402Fetch,
  });

  const client = new Client(options.clientInfo ?? { name: "l402-el2-agent", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/** Reads `/.well-known/l402` to discover prices and parameters before paying. */
export async function discoverL402Service(baseUrl: string | URL): Promise<{
  service: string;
  chainId: number;
  escrow: `0x${string}`;
  token: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
  provider: `0x${string}`;
  minDeposit: string;
  pricing: { default: string; resources: Record<string, string> };
}> {
  const url = new URL("/.well-known/l402", baseUrl);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Discovery failed (${response.status}) at ${url}`);
  return (await response.json()) as Awaited<ReturnType<typeof discoverL402Service>>;
}
