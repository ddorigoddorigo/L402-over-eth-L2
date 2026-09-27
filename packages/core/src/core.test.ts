import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";

import {
  attenuate,
  caveat,
  CaveatKeys,
  decodeMacaroon,
  encodeMacaroon,
  macaroonExpiry,
  MacaroonError,
  mintMacaroon,
  verifyMacaroon,
  verifySignature,
} from "./macaroon.js";
import {
  buildAuthorizationHeader,
  buildChallengeHeader,
  decodeProof,
  parseAuthorizationHeader,
  parseChallengeHeader,
  proofFromSignedVoucher,
  signedVoucherFromProof,
} from "./header.js";
import { computeChannelId, voucherTypedData, VOUCHER_TYPES, buildDomain } from "./eip712.js";
import { formatUnits, parseUnits } from "./units.js";
import { escrowAbi } from "./abi.js";
import type { PaymentRequest } from "./types.js";

const ROOT_KEY = randomBytes(32);
const ESCROW = "0x1111111111111111111111111111111111111111" as const;
const PROVIDER = "0x2222222222222222222222222222222222222222" as const;
const TOKEN = "0x3333333333333333333333333333333333333333" as const;
const CHAIN_ID = 8453;

describe("macaroon", () => {
  it("signs and verifies a macaroon without caveats", () => {
    const m = mintMacaroon({ rootKey: ROOT_KEY, service: "mcp.test" });
    expect(verifySignature(ROOT_KEY, m)).toBe(true);
    expect(verifySignature(randomBytes(32), m)).toBe(false);
  });

  it("survives encode/decode without changing its signature", () => {
    const m = mintMacaroon({
      rootKey: ROOT_KEY,
      service: "mcp.test",
      caveats: [caveat(CaveatKeys.expiresAt, "<=", 2_000_000_000), caveat(CaveatKeys.tool, "in", "a,b")],
    });
    const round = decodeMacaroon(encodeMacaroon(m));
    expect(round).toEqual(m);
    expect(verifySignature(ROOT_KEY, round)).toBe(true);
  });

  it("rejects the removal of a caveat", () => {
    const m = mintMacaroon({
      rootKey: ROOT_KEY,
      service: "mcp.test",
      caveats: [caveat(CaveatKeys.maxCumulative, "<=", 1000)],
    });
    const tampered = { ...m, caveats: [] };
    expect(verifySignature(ROOT_KEY, tampered)).toBe(false);
  });

  it("rejects a modified caveat value", () => {
    const m = mintMacaroon({
      rootKey: ROOT_KEY,
      service: "mcp.test",
      caveats: [caveat(CaveatKeys.maxCumulative, "<=", 1000)],
    });
    const tampered = { ...m, caveats: [caveat(CaveatKeys.maxCumulative, "<=", 999_999)] };
    expect(verifySignature(ROOT_KEY, tampered)).toBe(false);
  });

  it("allows attenuation without the root key and server-side verification", () => {
    const wide = mintMacaroon({ rootKey: ROOT_KEY, service: "mcp.test" });
    // The client (which does NOT have the root key) narrows the macaroon to a single tool.
    const narrow = attenuate(wide, [caveat(CaveatKeys.tool, "=", "search_web")]);

    expect(verifySignature(ROOT_KEY, narrow)).toBe(true);
    expect(verifyMacaroon(ROOT_KEY, narrow, { tool: "search_web" }).ok).toBe(true);

    const rejected = verifyMacaroon(ROOT_KEY, narrow, { tool: "drop_database" });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("caveat_failed");
  });

  it("compares numbers as bigints, not as strings", () => {
    const m = mintMacaroon({
      rootKey: ROOT_KEY,
      service: "mcp.test",
      caveats: [caveat(CaveatKeys.maxCumulative, "<=", "100000000000000000000")],
    });
    // 9e19 < 1e20: a lexicographic comparison would get it backwards ("9..." > "1...")
    expect(verifyMacaroon(ROOT_KEY, m, { max_cumulative: 90_000_000_000_000_000_000n }).ok).toBe(true);
    expect(verifyMacaroon(ROOT_KEY, m, { max_cumulative: 100_000_000_000_000_000_001n }).ok).toBe(false);
  });

  it("fails closed when the context does not know the caveat key", () => {
    const m = mintMacaroon({
      rootKey: ROOT_KEY,
      service: "mcp.test",
      caveats: [caveat("unknown_key", "=", "x")],
    });
    const result = verifyMacaroon(ROOT_KEY, m, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unknown_key");
  });

  it("enforces expiry with `expires_at <= deadline`", () => {
    const now = Math.floor(Date.now() / 1000);
    const m = mintMacaroon({
      rootKey: ROOT_KEY,
      service: "mcp.test",
      caveats: [caveat(CaveatKeys.expiresAt, "<=", now + 60)],
    });
    // The server puts "now" in the context: valid before the deadline, invalid after.
    expect(verifyMacaroon(ROOT_KEY, m, { expires_at: now }).ok).toBe(true);
    expect(verifyMacaroon(ROOT_KEY, m, { expires_at: now + 61 }).ok).toBe(false);
    expect(macaroonExpiry(m)).toBe(now + 60);
  });

  it("supports the `in` and `!=` operators", () => {
    const m = mintMacaroon({
      rootKey: ROOT_KEY,
      service: "mcp.test",
      caveats: [caveat(CaveatKeys.tool, "in", "a, b"), caveat(CaveatKeys.chainId, "!=", 1)],
    });
    expect(verifyMacaroon(ROOT_KEY, m, { tool: "b", chain_id: 8453 }).ok).toBe(true);
    expect(verifyMacaroon(ROOT_KEY, m, { tool: "c", chain_id: 8453 }).ok).toBe(false);
    expect(verifyMacaroon(ROOT_KEY, m, { tool: "a", chain_id: 1 }).ok).toBe(false);
  });

  it("keeps caveat values byte-for-byte through attenuation and encoding", () => {
    const wide = mintMacaroon({ rootKey: ROOT_KEY, service: "mcp.test" });
    const narrow = attenuate(wide, [caveat("note", "=", "  two leading spaces")]);
    const decoded = decodeMacaroon(encodeMacaroon(narrow));
    expect(decoded.caveats[0]!.value).toBe("  two leading spaces");
    expect(verifySignature(ROOT_KEY, decoded)).toBe(true);
  });

  it("rejects structurally invalid macaroons with a typed error", () => {
    const bad = Buffer.from(JSON.stringify({ i: { v: 1 }, c: [42], s: "00" })).toString("base64url");
    expect(() => decodeMacaroon(bad)).toThrow(MacaroonError);
  });
});

describe("L402 headers", () => {
  const paymentRequest: PaymentRequest = {
    scheme: "l402-el2",
    version: 1,
    chainId: CHAIN_ID,
    escrow: ESCROW,
    token: TOKEN,
    tokenSymbol: "cbBTC",
    tokenDecimals: 8,
    provider: PROVIDER,
    amount: "1000",
    cumulativeAmount: "5000",
    channelId: computeChannelId("0x4444444444444444444444444444444444444444", PROVIDER, TOKEN),
    nonce: 5,
    validUntil: 2_000_000_000,
    description: "search_web",
  };

  it("builds and re-parses the 402 challenge", () => {
    const macaroon = mintMacaroon({ rootKey: ROOT_KEY, service: "mcp.test" });
    const header = buildChallengeHeader(macaroon, paymentRequest);

    expect(header.startsWith("L402 ")).toBe(true);
    const parsed = parseChallengeHeader(header);
    expect(parsed.macaroon).toEqual(macaroon);
    expect(parsed.paymentRequest).toEqual(paymentRequest);
  });

  it("keeps the `invoice` alias for compatibility with existing L402 parsers", () => {
    const macaroon = mintMacaroon({ rootKey: ROOT_KEY, service: "mcp.test" });
    const header = buildChallengeHeader(macaroon, paymentRequest);
    expect(header).toMatch(/invoice="/);
    expect(header).toMatch(/payment_request="/);
  });

  it("builds and re-parses the Authorization header", () => {
    const macaroon = mintMacaroon({ rootKey: ROOT_KEY, service: "mcp.test" });
    const signed = {
      voucher: {
        channelId: paymentRequest.channelId!,
        cumulativeAmount: 5000n,
        nonce: 5n,
        validUntil: 2_000_000_000n,
      },
      signature: `0x${"ab".repeat(65)}` as const,
    };
    const header = buildAuthorizationHeader(macaroon, proofFromSignedVoucher(signed));
    const parsed = parseAuthorizationHeader(header);

    expect(parsed.macaroon).toEqual(macaroon);
    expect(parsed.proof.type).toBe("voucher");
    expect(signedVoucherFromProof(parsed.proof)).toEqual(signed);
  });

  it("rejects malformed headers", () => {
    expect(() => parseAuthorizationHeader("Bearer abc")).toThrow(/Unsupported authorization scheme/);
    expect(() => parseAuthorizationHeader("L402 nocolon")).toThrow(/Malformed L402 credentials/);
    expect(() => parseChallengeHeader('Basic realm="x"')).toThrow(/not L402/);
  });
});

describe("proof validation", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const valid = {
    type: "voucher",
    channelId: `0x${"11".repeat(32)}`,
    cumulativeAmount: "1000",
    nonce: 1,
    validUntil: 2_000_000_000,
    signature: `0x${"ab".repeat(65)}`,
  };

  it("accepts a well-formed voucher proof", () => {
    expect(decodeProof(encode(valid)).type).toBe("voucher");
  });

  it.each([
    ["non-numeric amount", { cumulativeAmount: "abc" }],
    ["negative amount", { cumulativeAmount: "-5" }],
    ["fractional nonce", { nonce: 1.5 }],
    ["string validUntil", { validUntil: "soon" }],
    ["short channelId", { channelId: "0x1234" }],
    ["non-hex signature", { signature: "hello" }],
    ["bad signer", { signer: "0xnope" }],
    ["unknown type", { type: "iou" }],
  ])("rejects a proof with %s as malformed_credentials", (_label, override) => {
    const error = (() => {
      try {
        decodeProof(encode({ ...valid, ...override }));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(MacaroonError);
    expect((error as MacaroonError).code).toBe("malformed_credentials");
  });

  it("rejects a payment request with missing fields", () => {
    const header = `L402 macaroon="${encodeMacaroon(mintMacaroon({ rootKey: ROOT_KEY, service: "s" }))}", invoice="${encode({ scheme: "l402-el2" })}"`;
    expect(() => parseChallengeHeader(header)).toThrow(/malformed fields/);
  });
});

describe("ABI", () => {
  it("matches the compiled contract (no drift between Solidity and TypeScript)", () => {
    const artifactPath = fileURLToPath(new URL("../../contracts/artifacts/L402Escrow.json", import.meta.url));
    if (!existsSync(artifactPath)) return; // contracts not compiled yet
    const compiled = JSON.parse(readFileSync(artifactPath, "utf8")).abi as {
      type: string;
      name?: string;
      inputs?: { type: string; components?: unknown[] }[];
    }[];
    const signature = (entry: { name?: string; inputs?: readonly { type: string }[] }) =>
      `${entry.name}(${(entry.inputs ?? []).map((i) => i.type).join(",")})`;
    const compiledSignatures = new Set(compiled.map(signature));
    for (const entry of escrowAbi) {
      expect(compiledSignatures, `missing in the contract: ${signature(entry)}`).toContain(signature(entry));
    }
  });
});

describe("EIP-712", () => {
  it("the channelId is deterministic and independent of address casing", () => {
    const lower = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" as const;
    const checksummed = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as const;
    expect(computeChannelId(lower, PROVIDER, TOKEN)).toBe(computeChannelId(checksummed, PROVIDER, TOKEN));
  });

  it("a voucher signature recovers to the signer address", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const voucher = {
      channelId: computeChannelId(account.address, PROVIDER, TOKEN),
      cumulativeAmount: 12_345n,
      nonce: 3n,
      validUntil: 2_000_000_000n,
    };
    const typedData = voucherTypedData(CHAIN_ID, ESCROW, voucher);
    const signature = await account.signTypedData(typedData);

    const recovered = await recoverTypedDataAddress({
      domain: buildDomain(CHAIN_ID, ESCROW),
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: voucher,
      signature,
    });
    expect(recovered).toBe(account.address);
  });

  it("changing chain or escrow invalidates the signature (no cross-chain replay)", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const voucher = {
      channelId: computeChannelId(account.address, PROVIDER, TOKEN),
      cumulativeAmount: 1n,
      nonce: 1n,
      validUntil: 2_000_000_000n,
    };
    const signature = await account.signTypedData(voucherTypedData(CHAIN_ID, ESCROW, voucher));

    const onOtherChain = await recoverTypedDataAddress({
      domain: buildDomain(42161, ESCROW),
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: voucher,
      signature,
    });
    expect(onOtherChain).not.toBe(account.address);
  });
});

describe("units", () => {
  it("converts back and forth without loss", () => {
    expect(parseUnits("0.00001", 8)).toBe(1000n);
    expect(formatUnits(1000n, 8)).toBe("0.00001");
    expect(formatUnits(100_000_000n, 8)).toBe("1");
    expect(parseUnits("1", 8)).toBe(100_000_000n);
  });

  it("rejects amounts with too many decimals instead of truncating them", () => {
    expect(() => parseUnits("0.000000001", 8)).toThrow(/decimals/);
  });

  it("rejects non-numeric input", () => {
    expect(() => parseUnits("abc", 8)).toThrow();
    expect(() => parseUnits("", 8)).toThrow();
  });
});
