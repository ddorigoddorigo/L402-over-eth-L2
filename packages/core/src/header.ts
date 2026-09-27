import type { Address, Hex } from "viem";
import { decodeMacaroon, encodeMacaroon, MacaroonError } from "./macaroon.js";
import {
  L402_SCHEME,
  type L402Credentials,
  type Macaroon,
  type PaymentProof,
  type PaymentRequest,
  type SignedVoucher,
} from "./types.js";

/**
 * Encoding / decoding of the protocol's HTTP headers.
 *
 * Challenge (402 response):
 *   WWW-Authenticate: L402 macaroon="<b64url>", invoice="<b64url>", payment_request="<b64url>", version="1"
 *
 * Credentials (follow-up request):
 *   Authorization: L402 <macaroon_b64url>:<proof_b64url>
 *
 * The `invoice` field keeps the name used by the original L402 so existing
 * parsers keep working; its content is an EVM PaymentRequest instead of a
 * Lightning invoice. It is also sent as `payment_request` for clarity.
 */

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/* --------------------------------- VALIDATION ------------------------------ */

export function isAddressLike(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isHexString(value: unknown): value is Hex {
  return typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);
}

/** Non-negative integer written in base 10, as used for uint256 amounts. */
function isUintString(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,78}$/.test(value);
}

function isUint64Number(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Returns what is wrong with a serialized signed voucher, or undefined if it is well-formed. */
export function serializedVoucherProblem(value: Record<string, unknown>): string | undefined {
  if (!isHex32(value.channelId)) return "`channelId` must be a 32-byte hex string";
  if (!isUintString(value.cumulativeAmount)) return "`cumulativeAmount` must be a decimal string";
  if (!isUint64Number(value.nonce)) return "`nonce` must be a non-negative integer";
  if (!isUint64Number(value.validUntil)) return "`validUntil` must be a non-negative integer";
  if (!isHexString(value.signature) || value.signature.length < 4) return "`signature` must be a hex string";
  if (value.signer !== undefined && !isAddressLike(value.signer)) return "`signer` must be an address";
  return undefined;
}

function malformed(message: string): MacaroonError {
  return new MacaroonError(message, "malformed_credentials");
}

/* --------------------------------- CHALLENGE ------------------------------- */

export function encodePaymentRequest(request: PaymentRequest): string {
  return toBase64Url(JSON.stringify(request));
}

export function decodePaymentRequest(encoded: string): PaymentRequest {
  let parsed: PaymentRequest;
  try {
    parsed = JSON.parse(fromBase64Url(encoded)) as PaymentRequest;
  } catch {
    throw new Error("Payment request is not valid base64url JSON");
  }
  if (parsed?.scheme !== "l402-el2") {
    throw new Error(`Unsupported payment scheme: ${String(parsed?.scheme)}`);
  }
  if (
    !isAddressLike(parsed.provider) ||
    !isAddressLike(parsed.escrow) ||
    !isAddressLike(parsed.token) ||
    !isUintString(parsed.amount) ||
    !Number.isSafeInteger(parsed.chainId) ||
    !isUint64Number(parsed.validUntil) ||
    (parsed.cumulativeAmount !== undefined && !isUintString(parsed.cumulativeAmount)) ||
    (parsed.lastVoucher !== undefined &&
      (typeof parsed.lastVoucher !== "object" ||
        serializedVoucherProblem(parsed.lastVoucher as unknown as Record<string, unknown>) !== undefined))
  ) {
    throw new Error("Payment request has missing or malformed fields");
  }
  return parsed;
}

export function buildChallengeHeader(macaroon: Macaroon, request: PaymentRequest): string {
  const encodedMacaroon = encodeMacaroon(macaroon);
  const invoice = encodePaymentRequest(request);
  return `${L402_SCHEME} macaroon="${encodedMacaroon}", invoice="${invoice}", payment_request="${invoice}", version="${request.version}"`;
}

export interface ParsedChallenge {
  macaroon: Macaroon;
  macaroonRaw: string;
  paymentRequest: PaymentRequest;
}

/** Extracts the challenge from a `WWW-Authenticate` header. */
export function parseChallengeHeader(header: string): ParsedChallenge {
  const trimmed = header.trim();
  if (!trimmed.toUpperCase().startsWith(`${L402_SCHEME} `)) {
    throw new Error(`WWW-Authenticate header is not L402: ${trimmed.slice(0, 40)}`);
  }
  const params = new Map<string, string>();
  for (const match of trimmed.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
    params.set(match[1]!.toLowerCase(), match[2]!);
  }

  const macaroonRaw = params.get("macaroon");
  const invoice = params.get("payment_request") ?? params.get("invoice");
  if (!macaroonRaw || !invoice) {
    throw new Error("Incomplete L402 challenge: `macaroon` and `invoice`/`payment_request` are required");
  }
  return {
    macaroon: decodeMacaroon(macaroonRaw),
    macaroonRaw,
    paymentRequest: decodePaymentRequest(invoice),
  };
}

/* -------------------------------- CREDENTIALS ------------------------------ */

export function encodeProof(proof: PaymentProof): string {
  return toBase64Url(JSON.stringify(proof));
}

/**
 * Decodes and validates a proof. Every field is checked here, so that code
 * downstream (BigInt conversions, signature checks) never sees garbage coming
 * from the network.
 */
export function decodeProof(encoded: string): PaymentProof {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fromBase64Url(encoded)) as Record<string, unknown>;
  } catch {
    throw malformed("Proof is not valid base64url JSON");
  }
  if (!parsed || typeof parsed !== "object") throw malformed("Proof must be a JSON object");

  if (parsed.type === "voucher") {
    const problem = serializedVoucherProblem(parsed);
    if (problem) throw malformed(`Proof: ${problem}`);
    return parsed as unknown as PaymentProof;
  }
  if (parsed.type === "tx") {
    if (!isHex32(parsed.txHash) || !isAddressLike(parsed.payer)) {
      throw malformed("Proof: `tx` proofs need `txHash` and `payer`");
    }
    return parsed as unknown as PaymentProof;
  }
  throw malformed(`Unknown proof type: ${String(parsed.type)}`);
}

export function proofFromSignedVoucher(signed: SignedVoucher): PaymentProof {
  return {
    type: "voucher",
    channelId: signed.voucher.channelId,
    cumulativeAmount: signed.voucher.cumulativeAmount.toString(),
    nonce: Number(signed.voucher.nonce),
    validUntil: Number(signed.voucher.validUntil),
    signature: signed.signature,
    ...(signed.signer ? { signer: signed.signer } : {}),
  };
}

export function signedVoucherFromProof(proof: PaymentProof): SignedVoucher {
  if (proof.type !== "voucher") throw new Error("The proof does not contain a voucher");
  return {
    voucher: {
      channelId: proof.channelId,
      cumulativeAmount: BigInt(proof.cumulativeAmount),
      nonce: BigInt(proof.nonce),
      validUntil: BigInt(proof.validUntil),
    },
    signature: proof.signature,
    ...(proof.signer ? { signer: proof.signer } : {}),
  };
}

export function buildAuthorizationHeader(macaroon: Macaroon | string, proof: PaymentProof): string {
  const encodedMacaroon = typeof macaroon === "string" ? macaroon : encodeMacaroon(macaroon);
  return `${L402_SCHEME} ${encodedMacaroon}:${encodeProof(proof)}`;
}

/** Extracts macaroon + proof from an `Authorization` header. */
export function parseAuthorizationHeader(header: string): L402Credentials {
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toUpperCase() !== L402_SCHEME) {
    throw malformed(`Unsupported authorization scheme: ${scheme || "(empty)"}`);
  }
  const payload = rest.join(" ");
  const separator = payload.indexOf(":");
  if (separator < 0) {
    throw malformed("Malformed L402 credentials: expected <macaroon>:<proof>");
  }
  const macaroonRaw = payload.slice(0, separator);
  const proofRaw = payload.slice(separator + 1);
  if (!macaroonRaw || !proofRaw) {
    throw malformed("Incomplete L402 credentials");
  }
  return {
    macaroon: decodeMacaroon(macaroonRaw),
    macaroonRaw,
    proof: decodeProof(proofRaw),
  };
}

/* ------------------------------ AUXILIARY HEADERS -------------------------- */

/** Header the client uses to declare its address before having paid. */
export const PAYER_HEADER = "x-l402-payer";
/** Header the server uses to report the remaining channel balance. */
export const BALANCE_HEADER = "x-l402-channel-balance";
/** Header the server uses to report the cumulative amount expected next. */
export const NEXT_CUMULATIVE_HEADER = "x-l402-next-cumulative";
