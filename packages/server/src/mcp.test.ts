import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { billableResources, createMcpL402App } from "./mcp.js";
import type { Gatekeeper } from "./gatekeeper.js";

const priceOf = (resource: string) => (resource === "free_tool" ? 0n : 100n);
const toolCall = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

describe("billableResources", () => {
  it("ignores free methods and free tools", () => {
    expect(billableResources({ jsonrpc: "2.0", id: 1, method: "tools/list" }, priceOf)).toEqual([]);
    expect(billableResources(toolCall(1, "free_tool"), priceOf)).toEqual([]);
    expect(billableResources([toolCall(1, "a"), toolCall(2, "b")], priceOf)).toEqual(["a", "b"]);
  });
});

describe("createMcpL402App", () => {
  const authorize = vi.fn();
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const gatekeeper = { priceOf, authorize, discovery: () => ({}) } as unknown as Gatekeeper;
    const app = createMcpL402App({
      gatekeeper,
      createServer: () => new McpServer({ name: "test", version: "0.0.0" }),
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
  });

  afterAll(() => {
    server.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });

  it("rejects a JSON-RPC batch with several paid calls (one voucher would pay for many)", async () => {
    const response = await post([toolCall(1, "search"), toolCall(2, "search")]);
    expect(response.status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("answers 404 to an unknown session id instead of creating a new transport", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-session-id": "nope" });
    expect(response.status).toBe(404);
  });

  it("requires `initialize` to start a session", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(400);
  });
});
