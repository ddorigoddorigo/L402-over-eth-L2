import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { PAYER_HEADER } from "@l402-el2/core";

import type { Gatekeeper } from "./gatekeeper.js";
import { l402Discovery, setPaymentHeaders, statusFor } from "./http.js";

/**
 * Paid MCP server.
 *
 * The gate does not live inside the tools but in front of the transport: the
 * middleware inspects the incoming JSON-RPC message and charges only the
 * billable methods. `initialize`, `tools/list` and notifications stay free — an
 * agent must be able to discover what the server offers and what it costs
 * before opening a channel.
 */

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; uri?: string; [key: string]: unknown };
}

/**
 * Billable MCP methods, and how to derive the resource name from each.
 *
 * This is an allowlist, not a denylist: handshake, `tools/list`, notifications
 * and pings are free by construction — and a new method introduced by a future
 * MCP version cannot become paid (or free) by mistake.
 */
const BILLABLE_METHODS: Record<string, (params: JsonRpcMessage["params"]) => string | undefined> = {
  "tools/call": (params) => (typeof params?.name === "string" ? params.name : undefined),
  "resources/read": (params) => (typeof params?.uri === "string" ? params.uri : undefined),
  "prompts/get": (params) => (typeof params?.name === "string" ? params.name : undefined),
};

/** JSON-RPC error code mirroring HTTP 402 in the JSON-RPC error space. */
export const PAYMENT_REQUIRED_RPC_CODE = -32402;

function messagesOf(body: unknown): JsonRpcMessage[] {
  if (Array.isArray(body)) return body as JsonRpcMessage[];
  if (body && typeof body === "object") return [body as JsonRpcMessage];
  return [];
}

/** Every paid call contained in a (possibly batched) JSON-RPC body. */
export function billableResources(body: unknown, priceOf: (resource: string) => bigint): string[] {
  const resources: string[] = [];
  for (const message of messagesOf(body)) {
    const extract = message.method ? BILLABLE_METHODS[message.method] : undefined;
    if (!extract) continue;
    const resource = extract(message.params) ?? message.method!;
    if (priceOf(resource) > 0n) resources.push(resource);
  }
  return resources;
}

/**
 * The single paid resource of a request, or `undefined` if the request is free.
 * Throws if the body batches several paid calls: one voucher pays exactly one call.
 */
export function billableResource(body: unknown, priceOf: (resource: string) => bigint): string | undefined {
  const resources = billableResources(body, priceOf);
  if (resources.length > 1) throw new Error("A JSON-RPC batch may contain at most one paid call");
  return resources[0];
}

export interface McpL402Options {
  gatekeeper: Gatekeeper;
  /**
   * Price of a resource. Defaults to the gatekeeper's own pricing policy; only
   * override it if you know what you are doing — the gatekeeper still charges
   * according to its own pricing.
   */
  priceOf?: (resource: string) => bigint;
  /** Audit callback invoked for every accepted payment. */
  onPayment?: (info: { payer: string; resource: string; price: bigint; cumulativeAmount: bigint }) => void;
}

function jsonRpcError(res: Response, status: number, id: JsonRpcMessage["id"], code: number, message: string, data?: unknown) {
  res.status(status).json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
}

/**
 * MCP-aware L402 middleware. Mount it BEFORE the transport and after `express.json()`.
 *
 * A JSON-RPC batch with more than one paid call is rejected: charging a single
 * voucher for N calls would be a trivial way to skip payment, and a macaroon
 * restricted to one tool (`tool` caveat) could otherwise smuggle other tools in.
 */
export function mcpL402Middleware({ gatekeeper, priceOf, onPayment }: McpL402Options): RequestHandler {
  const price = priceOf ?? ((resource: string) => gatekeeper.priceOf(resource));

  return async (req: Request, res: Response, next) => {
    if (req.method !== "POST") return next();

    const firstId = messagesOf(req.body)[0]?.id;
    const resources = billableResources(req.body, price);
    if (resources.length === 0) return next(); // only free methods in this message
    if (resources.length > 1) {
      jsonRpcError(res, 400, firstId, -32600, "A JSON-RPC batch may contain at most one paid call: send them separately");
      return;
    }
    const resource = resources[0]!;

    try {
      const payerHint = req.header(PAYER_HEADER);
      const result = await gatekeeper.authorize({
        authorization: req.header("authorization"),
        resource,
        ...(payerHint ? { payerHint } : {}),
      });
      setPaymentHeaders(res, result);

      if (!result.ok) {
        jsonRpcError(res, statusFor(result.code), firstId, PAYMENT_REQUIRED_RPC_CODE, `Payment Required: ${result.reason}`, {
          l402: result.code,
          resource,
          payment: result.challenge.paymentRequest,
          wwwAuthenticate: result.challenge.header,
        });
        return;
      }

      onPayment?.({ payer: result.payer, resource, price: result.price, cumulativeAmount: result.cumulativeAmount });
      next();
    } catch (error) {
      next(error);
    }
  };
}

export interface McpAppOptions extends McpL402Options {
  /** Builds the MCP server with its tools. Called once per session. */
  createServer: () => McpServer;
  /** Path of the MCP endpoint. Default `/mcp`. */
  path?: string;
  /** Serve `/.well-known/l402`. Default true. */
  discovery?: boolean;
}

/**
 * Ready-to-use Express app: a Streamable HTTP MCP endpoint protected by L402,
 * plus the discovery document and a health check.
 */
export function createMcpL402App(options: McpAppOptions): Express {
  const path = options.path ?? "/mcp";
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  if (options.discovery !== false) {
    app.get("/.well-known/l402", l402Discovery(options.gatekeeper));
  }
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Only JSON bodies reach the paywall: anything else is refused up front instead
  // of relying on the transport to reject a body the middleware could not inspect.
  app.post(path, (req, res, next) => {
    if (!req.is("application/json")) {
      jsonRpcError(res, 415, null, -32000, "Unsupported Media Type: Content-Type must be application/json");
      return;
    }
    next();
  });

  app.post(path, mcpL402Middleware(options), async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId) {
        jsonRpcError(res, 404, null, -32001, "Unknown MCP session: initialize a new one");
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, null, -32000, "No MCP session: the first request must be `initialize`");
        return;
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId) transports.delete(created.sessionId);
      };
      await options.createServer().connect(created);
      transport = created;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const forwardToSession = async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(sessionId ? 404 : 400).json({ error: "Unknown MCP session" });
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get(path, forwardToSession);
  app.delete(path, forwardToSession);

  return app;
}
