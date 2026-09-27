import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CAVEAT_OPERATORS, type Caveat, type CaveatOp, type Macaroon, type MacaroonIdentifier } from "./types.js";

/**
 * First-party macaroons for L402-EL2.
 *
 * Why not a JWT: a macaroon can be *attenuated* by whoever holds it, without
 * knowing the server's key. An AI agent holding a macaroon that is "valid for
 * every tool up to 0.001 BTC" can derive one that is "valid only for search_web
 * during the next 60 seconds" and hand it to a sub-agent; the server verifies it
 * with the same root key. That property is what makes L402 fit delegation chains
 * between agents.
 *
 * Signature chain:
 *   sig_0 = HMAC(rootKey, identifier)
 *   sig_i = HMAC(sig_{i-1}, caveat_i)
 * A caveat cannot be removed or edited without invalidating the final signature.
 */

const MACAROON_VERSION = 1;

export type { CaveatOp } from "./types.js";

export class MacaroonError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_macaroon" | "malformed_credentials" | "caveat_failed",
    readonly caveat?: Caveat,
  ) {
    super(message);
    this.name = "MacaroonError";
  }
}

/* -------------------------------------------------------------------------- */
/*                                SERIALIZATION                               */
/* -------------------------------------------------------------------------- */

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

/** Canonical form of the identifier: key order must never change the signature. */
function canonicalIdentifier(id: MacaroonIdentifier): string {
  return JSON.stringify({ v: id.v, service: id.service, tokenId: id.tokenId, channelId: id.channelId ?? null });
}

export function serializeCaveat(c: Caveat): string {
  return `${c.key} ${c.op} ${c.value}`;
}

const operatorPattern = CAVEAT_OPERATORS.map((op) => op.replace(/[<>=!]/g, (ch) => `\\${ch}`)).join("|");
/**
 * Canonical form only: exactly one space around the operator, as produced by
 * `serializeCaveat`. A looser pattern would turn "k =  v" into value "v" and the
 * re-serialized caveat would no longer match the signature it was attenuated with.
 */
const CAVEAT_REGEX = new RegExp(`^(\\S+) (${operatorPattern}) ([\\s\\S]*)$`);

export function parseCaveat(raw: string): Caveat {
  if (typeof raw !== "string") {
    throw new MacaroonError("Malformed caveat: expected a string", "malformed_credentials");
  }
  const match = raw.match(CAVEAT_REGEX);
  if (!match) throw new MacaroonError(`Malformed caveat: "${raw}"`, "malformed_credentials");
  const [, key, op, value] = match;
  return { key: key!, op: op as CaveatOp, value: value! };
}

/* -------------------------------------------------------------------------- */
/*                             MINTING AND SIGNING                            */
/* -------------------------------------------------------------------------- */

function hmac(key: Uint8Array, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function toKey(rootKey: Buffer | string): Buffer {
  return Buffer.isBuffer(rootKey) ? rootKey : Buffer.from(rootKey, "hex");
}

function signChain(rootKey: Uint8Array, identifier: MacaroonIdentifier, caveats: Caveat[]): Buffer {
  let signature = hmac(rootKey, canonicalIdentifier(identifier));
  for (const caveat of caveats) signature = hmac(signature, serializeCaveat(caveat));
  return signature;
}

export function newTokenId(): string {
  return randomBytes(16).toString("hex");
}

export interface MintOptions {
  rootKey: Buffer | string;
  service: string;
  tokenId?: string;
  channelId?: `0x${string}`;
  caveats?: Caveat[];
}

export function mintMacaroon(options: MintOptions): Macaroon {
  const identifier: MacaroonIdentifier = {
    v: MACAROON_VERSION,
    service: options.service,
    tokenId: options.tokenId ?? newTokenId(),
    ...(options.channelId ? { channelId: options.channelId } : {}),
  };
  const caveats = options.caveats ?? [];
  return { identifier, caveats, signature: signChain(toKey(options.rootKey), identifier, caveats).toString("hex") };
}

/**
 * Appends caveats to an existing macaroon. Anyone can do it, no root key needed.
 * The result is strictly less powerful than the original.
 */
export function attenuate(macaroon: Macaroon, caveats: Caveat[]): Macaroon {
  let signature: Buffer = Buffer.from(macaroon.signature, "hex");
  for (const caveat of caveats) signature = hmac(signature, serializeCaveat(caveat));
  return {
    identifier: macaroon.identifier,
    caveats: [...macaroon.caveats, ...caveats],
    signature: signature.toString("hex"),
  };
}

export function encodeMacaroon(macaroon: Macaroon): string {
  return base64UrlEncode(
    JSON.stringify({
      i: macaroon.identifier,
      c: macaroon.caveats.map(serializeCaveat),
      s: macaroon.signature,
    }),
  );
}

function isValidIdentifier(value: unknown): value is MacaroonIdentifier {
  if (!value || typeof value !== "object") return false;
  const id = value as Record<string, unknown>;
  return (
    typeof id.v === "number" &&
    typeof id.service === "string" &&
    typeof id.tokenId === "string" &&
    (id.channelId === undefined || id.channelId === null || typeof id.channelId === "string")
  );
}

export function decodeMacaroon(encoded: string): Macaroon {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(encoded));
  } catch {
    throw new MacaroonError("Macaroon cannot be decoded", "malformed_credentials");
  }
  const obj = parsed as { i?: unknown; c?: unknown; s?: unknown } | null;
  if (!obj || !isValidIdentifier(obj.i) || typeof obj.s !== "string" || !Array.isArray(obj.c)) {
    throw new MacaroonError("Invalid macaroon structure", "malformed_credentials");
  }
  const { v, service, tokenId, channelId } = obj.i;
  const identifier: MacaroonIdentifier = { v, service, tokenId, ...(channelId ? { channelId } : {}) };
  return {
    identifier,
    caveats: obj.c.map((raw) => parseCaveat(raw as string)),
    signature: obj.s,
  };
}

/** Checks the HMAC chain only. Caveats are not evaluated: use `verifyMacaroon` for that. */
export function verifySignature(rootKey: Buffer | string, macaroon: Macaroon): boolean {
  const expected = signChain(toKey(rootKey), macaroon.identifier, macaroon.caveats);
  // Buffer.from(..., "hex") never throws: invalid hex just yields a shorter buffer.
  const actual = Buffer.from(macaroon.signature, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/* -------------------------------------------------------------------------- */
/*                             CAVEAT EVALUATION                              */
/* -------------------------------------------------------------------------- */

export type CaveatContext = Record<string, string | number | bigint | undefined>;

function parseInteger(value: string): bigint | undefined {
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? BigInt(trimmed) : undefined;
}

/**
 * Evaluates `actual <op> expected`.
 *
 * Integers are compared as bigints (never lexicographically). Everything else is
 * compared as a case-insensitive string; ordering operators on non-numeric
 * values fail closed.
 */
function compare(actual: string | number | bigint, expected: string, op: CaveatOp): boolean {
  if (op === "in") {
    return expected
      .split(",")
      .map((item) => item.trim())
      .includes(String(actual));
  }

  const actualNumber = typeof actual === "string" ? parseInteger(actual) : BigInt(actual);
  const expectedNumber = parseInteger(expected);
  if (actualNumber !== undefined && expectedNumber !== undefined) {
    switch (op) {
      case "=":
        return actualNumber === expectedNumber;
      case "!=":
        return actualNumber !== expectedNumber;
      case "<":
        return actualNumber < expectedNumber;
      case "<=":
        return actualNumber <= expectedNumber;
      case ">":
        return actualNumber > expectedNumber;
      case ">=":
        return actualNumber >= expectedNumber;
    }
  }

  const left = String(actual).toLowerCase();
  const right = expected.toLowerCase();
  switch (op) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    default:
      // Ordering comparisons on non-numeric strings make no sense: fail closed.
      return false;
  }
}

export type MacaroonVerification =
  | { ok: true }
  | { ok: false; code: "invalid_macaroon" | "caveat_failed"; reason: string; caveat?: Caveat };

/**
 * Verifies signature + caveats.
 *
 * Fail-closed: if a caveat references a key the context does not know, the
 * verification fails. A server that cannot evaluate a restriction must not
 * declare it satisfied.
 */
export function verifyMacaroon(
  rootKey: Buffer | string,
  macaroon: Macaroon,
  context: CaveatContext,
): MacaroonVerification {
  if (!verifySignature(rootKey, macaroon)) {
    return { ok: false, code: "invalid_macaroon", reason: "Invalid macaroon signature" };
  }
  for (const caveat of macaroon.caveats) {
    const actual = context[caveat.key];
    if (actual === undefined) {
      return {
        ok: false,
        code: "caveat_failed",
        reason: `Caveat cannot be evaluated: key "${caveat.key}" is not in the context`,
        caveat,
      };
    }
    if (!compare(actual, caveat.value, caveat.op)) {
      return {
        ok: false,
        code: "caveat_failed",
        reason: `Caveat not satisfied: ${serializeCaveat(caveat)} (actual value: ${actual})`,
        caveat,
      };
    }
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*                         STANDARD CAVEATS OF THE PROFILE                    */
/* -------------------------------------------------------------------------- */

export const CaveatKeys = {
  /** Absolute macaroon expiry (unix seconds). Use as `expires_at <= <deadline>`. */
  expiresAt: "expires_at",
  /** Channel the macaroon is bound to. */
  channelId: "channel_id",
  /** Authorized payer. */
  payer: "payer",
  /** Chain the payment must happen on. */
  chainId: "chain_id",
  /** Accepted token. */
  token: "token",
  /** Cumulative spending cap granted under this macaroon. */
  maxCumulative: "max_cumulative",
  /** Allowed MCP tools (comma-separated list with `in`). */
  tool: "tool",
  /** Service that issued the macaroon. */
  service: "service",
} as const;

export function caveat(key: string, op: CaveatOp, value: string | number | bigint): Caveat {
  if (!/^\S+$/.test(key)) throw new MacaroonError(`Invalid caveat key: "${key}"`, "malformed_credentials");
  return { key, op, value: String(value) };
}

/** Reads the `expires_at <= N` caveat, if any (the strictest one wins). */
export function macaroonExpiry(macaroon: Macaroon): number | undefined {
  let expiry: number | undefined;
  for (const c of macaroon.caveats) {
    if (c.key !== CaveatKeys.expiresAt || (c.op !== "<=" && c.op !== "<")) continue;
    const value = Number(c.value);
    if (!Number.isFinite(value)) continue;
    const deadline = c.op === "<" ? value - 1 : value;
    expiry = expiry === undefined ? deadline : Math.min(expiry, deadline);
  }
  return expiry;
}
