import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getAddress, serializeErc6492Signature, type Address, type PublicClient } from "viem";
import {
  attenuate,
  buildAuthorizationHeader,
  caveat,
  CaveatKeys,
  computeChannelId,
  decodeMacaroon,
  encodeMacaroon,
  parseChallengeHeader,
  proofFromSignedVoucher,
  voucherTypedData,
  type Voucher,
} from "@l402-el2/core";

import { startEvm, type TestEvm } from "../../contracts/tools/evm.mjs";
import { Gatekeeper } from "./gatekeeper.js";
import { MemoryVoucherStore } from "./store/memory.js";

const PRICE = 250n;
const DEPOSIT = 1_000_000n;

interface Ctx {
  evm: TestEvm;
  gatekeeper: Gatekeeper;
  store: MemoryVoucherStore;
  payer: Address;
  provider: Address;
  escrow: Address;
  token: Address;
  chainId: number;
  signVoucher(voucher: Voucher, accountIndex?: number): Promise<`0x${string}`>;
  channelId: `0x${string}`;
}

let ctx: Ctx;

beforeAll(async () => {
  const evm = await startEvm();
  const [deployer, providerAccount, payerAccount] = evm.accounts;

  const token = await evm.deploy("MockBTC");
  const escrow = await evm.deploy("L402Escrow", [deployer!.address, deployer!.address, 0]);
  const publicClient = evm.publicClient as PublicClient;

  const send = async (index: number, contract: { address: Address; abi: unknown }, functionName: string, args: unknown[]) => {
    const hash = await evm.wallets[index]!.writeContract({
      address: contract.address,
      abi: contract.abi as never,
      functionName,
      args: args as never,
      account: evm.accounts[index]!,
      chain: evm.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  };

  await send(0, token, "mint", [payerAccount!.address, DEPOSIT * 10n]);
  await send(2, token, "approve", [escrow.address, DEPOSIT * 10n]);
  await send(2, escrow, "openChannel", [providerAccount!.address, token.address, DEPOSIT, 30n * 86400n]);

  const store = new MemoryVoucherStore();
  const gatekeeper = new Gatekeeper({
    service: "test.mcp",
    rootKey: randomBytes(32),
    provider: getAddress(providerAccount!.address),
    chainId: evm.chain.id,
    escrow: escrow.address,
    token: token.address,
    tokenSymbol: "cbBTC",
    tokenDecimals: 8,
    publicClient,
    store,
    pricing: { default: PRICE, resources: { expensive: 5_000n } },
    minChannelTimeLeft: 60,
  });

  ctx = {
    evm,
    gatekeeper,
    store,
    payer: getAddress(payerAccount!.address),
    provider: getAddress(providerAccount!.address),
    escrow: escrow.address,
    token: token.address,
    chainId: evm.chain.id,
    channelId: computeChannelId(getAddress(payerAccount!.address), getAddress(providerAccount!.address), token.address),
    async signVoucher(voucher, accountIndex = 2) {
      const account = evm.accounts[accountIndex]!;
      return account.signTypedData(voucherTypedData(evm.chain.id, escrow.address, voucher));
    },
  };
}, 60_000);

/** Builds a valid Authorization header for the next call. */
async function validAuthorization(resource = "tool_a", overrides: Partial<Voucher> = {}, accountIndex = 2) {
  const challenge = await ctx.gatekeeper.challenge({ resource, payer: ctx.payer });
  const request = challenge.paymentRequest;
  const voucher: Voucher = {
    channelId: ctx.channelId,
    cumulativeAmount: BigInt(request.cumulativeAmount!),
    nonce: 1n,
    validUntil: BigInt(request.validUntil),
    ...overrides,
  };
  const signature = await ctx.signVoucher(voucher, accountIndex);
  return {
    header: buildAuthorizationHeader(
      challenge.macaroonEncoded,
      proofFromSignedVoucher({ voucher, signature }),
    ),
    challenge,
    voucher,
    signature,
  };
}

describe("challenge", () => {
  it("issues a 402 with a consistent macaroon and payment request", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });

    expect(challenge.price).toBe(PRICE);
    expect(challenge.paymentRequest.channelId).toBe(ctx.channelId);
    expect(challenge.paymentRequest.cumulativeAmount).toBe(PRICE.toString());
    expect(getAddress(challenge.paymentRequest.provider)).toBe(ctx.provider);

    const parsed = parseChallengeHeader(challenge.header);
    expect(parsed.paymentRequest).toEqual(challenge.paymentRequest);
    expect(parsed.macaroon.caveats.some((c) => c.key === CaveatKeys.payer)).toBe(true);
  });

  it("without X-L402-Payer it issues an unbound challenge", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "tool_a" });
    expect(challenge.paymentRequest.channelId).toBeUndefined();
    expect(challenge.macaroon.caveats.some((c) => c.key === CaveatKeys.payer)).toBe(false);
  });

  it("applies per-resource pricing", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "expensive", payer: ctx.payer });
    expect(challenge.price).toBe(5_000n);
  });
});

describe("authorization — happy path", () => {
  it("accepts a valid voucher and advances the cumulative amount", async () => {
    const { header } = await validAuthorization();
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payer).toBe(ctx.payer);
    expect(result.cumulativeAmount).toBe(PRICE);
    expect(result.delta).toBe(PRICE);
    expect(result.remaining).toBe(DEPOSIT - PRICE);
  });

  it("the next call requires a higher cumulative amount", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });
    expect(BigInt(challenge.paymentRequest.cumulativeAmount!)).toBe(PRICE * 2n);

    const { header } = await validAuthorization("tool_a", { nonce: 2n });
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cumulativeAmount).toBe(PRICE * 2n);
  });
});

describe("authorization — attacks", () => {
  it("rejects missing credentials with a usable challenge", async () => {
    const result = await ctx.gatekeeper.authorize({ authorization: undefined, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing_credentials");
    expect(result.challenge.header).toContain("L402 macaroon=");
  });

  it("rejects a replay of the same voucher", async () => {
    const { header } = await validAuthorization("tool_a", { nonce: 10n });
    const first = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(first.ok).toBe(true);

    const replay = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe("insufficient_payment");
  });

  it("rejects a voucher signed by another account", async () => {
    const { header } = await validAuthorization("tool_a", { nonce: 20n }, 4);
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_signature");
  });

  it("rejects a macaroon with a tampered signature", async () => {
    const { header, voucher, signature } = await validAuthorization("tool_a", { nonce: 30n });
    const macaroonRaw = header.split(" ")[1]!.split(":")[0]!;
    const macaroon = decodeMacaroon(macaroonRaw);
    const forged = { ...macaroon, signature: randomBytes(32).toString("hex") };

    const tampered = buildAuthorizationHeader(
      encodeMacaroon(forged),
      proofFromSignedVoucher({ voucher, signature }),
    );
    const result = await ctx.gatekeeper.authorize({ authorization: tampered, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_macaroon");
  });

  it("rejects a macaroon whose spending cap was stripped", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });
    const macaroon = challenge.macaroon;
    const stripped = {
      ...macaroon,
      caveats: macaroon.caveats.filter((c) => c.key !== CaveatKeys.maxCumulative),
    };

    const voucher: Voucher = {
      channelId: ctx.channelId,
      cumulativeAmount: BigInt(challenge.paymentRequest.cumulativeAmount!),
      nonce: 40n,
      validUntil: BigInt(challenge.paymentRequest.validUntil),
    };
    const header = buildAuthorizationHeader(
      encodeMacaroon(stripped),
      proofFromSignedVoucher({ voucher, signature: await ctx.signVoucher(voucher) }),
    );

    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_macaroon");
  });

  it("rejects a voucher pointing to another channel", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });
    const voucher: Voucher = {
      channelId: computeChannelId(ctx.payer, ctx.payer, ctx.token), // made-up channel
      cumulativeAmount: BigInt(challenge.paymentRequest.cumulativeAmount!),
      nonce: 50n,
      validUntil: BigInt(challenge.paymentRequest.validUntil),
    };
    const header = buildAuthorizationHeader(
      challenge.macaroonEncoded,
      proofFromSignedVoucher({ voucher, signature: await ctx.signVoucher(voucher) }),
    );
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_proof");
  });

  it("rejects an expired voucher", async () => {
    const { header } = await validAuthorization("tool_a", {
      nonce: 60n,
      validUntil: BigInt(Math.floor(Date.now() / 1000) - 3600),
    });
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("voucher_expired");
  });

  it("rejects a payment below the price of the requested resource", async () => {
    // Voucher signed for the price of "tool_a", presented for "expensive".
    const { header } = await validAuthorization("tool_a", { nonce: 70n });
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "expensive" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("insufficient_payment");
  });

  it("rejects a voucher above the channel deposit", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });
    const voucher: Voucher = {
      channelId: ctx.channelId,
      cumulativeAmount: DEPOSIT * 100n,
      nonce: 80n,
      validUntil: BigInt(challenge.paymentRequest.validUntil),
    };
    const header = buildAuthorizationHeader(
      challenge.macaroonEncoded,
      proofFromSignedVoucher({ voucher, signature: await ctx.signVoucher(voucher) }),
    );
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["insufficient_deposit", "caveat_failed"]).toContain(result.code);
  });

  it("rejects a revoked macaroon", async () => {
    const { header, challenge } = await validAuthorization("tool_a", { nonce: 90n });
    await ctx.gatekeeper.revoke(challenge.macaroon.identifier.tokenId);
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("revoked");
  });

  it("N concurrent requests with the same voucher let exactly one through", async () => {
    const { header } = await validAuthorization("tool_a", { nonce: 100n });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("client-side attenuation", () => {
  it("a macaroon restricted to one tool is not valid for others", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });
    const restricted = attenuate(challenge.macaroon, [caveat(CaveatKeys.tool, "=", "tool_a")]);

    const voucher: Voucher = {
      channelId: ctx.channelId,
      cumulativeAmount: BigInt(challenge.paymentRequest.cumulativeAmount!) + PRICE * 10n,
      nonce: 200n,
      validUntil: BigInt(challenge.paymentRequest.validUntil),
    };
    const signature = await ctx.signVoucher(voucher);
    const header = buildAuthorizationHeader(encodeMacaroon(restricted), proofFromSignedVoucher({ voucher, signature }));

    const allowed = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(allowed.ok).toBe(true);

    const voucher2: Voucher = { ...voucher, cumulativeAmount: voucher.cumulativeAmount + PRICE, nonce: 201n };
    const header2 = buildAuthorizationHeader(
      encodeMacaroon(restricted),
      proofFromSignedVoucher({ voucher: voucher2, signature: await ctx.signVoucher(voucher2) }),
    );
    const denied = await ctx.gatekeeper.authorize({ authorization: header2, resource: "tool_b" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("caveat_failed");
  });
});

describe("settleability guarantees", () => {
  it("rejects a voucher that would expire before it can be settled", async () => {
    const { header } = await validAuthorization("tool_a", {
      nonce: 300n,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 30), // valid, but only for 30 seconds
    });
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("voucher_expired");
  });

  it("answers malformed proofs with malformed_credentials instead of throwing", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });
    const badProof = Buffer.from(
      JSON.stringify({ type: "voucher", channelId: ctx.channelId, cumulativeAmount: "lots", nonce: 1, validUntil: 1, signature: "0x00" }),
    ).toString("base64url");
    const result = await ctx.gatekeeper.authorize({
      authorization: `L402 ${challenge.macaroonEncoded}:${badProof}`,
      resource: "tool_a",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("malformed_credentials");
  });

  it("never asks for (or accepts) an amount at or below the on-chain floor", async () => {
    // The store only knows an old voucher (e.g. restored from a stale backup, or the
    // voucher was settled through another instance): the on-chain floor must win.
    const { evm, escrow, token } = ctx;
    const [, providerAccount, , , , , , , payer2] = evm.accounts;
    const publicClient = evm.publicClient as PublicClient;
    const write = async (index: number, address: Address, abi: unknown, functionName: string, args: unknown[]) => {
      const hash = await evm.wallets[index]!.writeContract({
        address,
        abi: abi as never,
        functionName,
        args: args as never,
        account: evm.accounts[index]!,
        chain: evm.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    };
    const tokenAbi = (await import("../../contracts/tools/evm.mjs")).loadArtifact("MockBTC").abi;
    const escrowAbiFull = (await import("../../contracts/tools/evm.mjs")).loadArtifact("L402Escrow").abi;

    await write(0, token, tokenAbi, "mint", [payer2!.address, DEPOSIT]);
    await write(8, token, tokenAbi, "approve", [escrow, DEPOSIT]);
    await write(8, escrow, escrowAbiFull, "openChannel", [providerAccount!.address, token, DEPOSIT, 30n * 86400n]);

    const channelId = computeChannelId(getAddress(payer2!.address), ctx.provider, token);
    const settled: Voucher = { channelId, cumulativeAmount: 10_000n, nonce: 1n, validUntil: BigInt(Math.floor(Date.now() / 1000) + 86_400) };
    const settledSig = await evm.accounts[8]!.signTypedData(voucherTypedData(ctx.chainId, escrow, settled));
    await write(1, escrow, escrowAbiFull, "settle", [settled, settledSig, "0x0000000000000000000000000000000000000000"]);

    const staleStore = new MemoryVoucherStore();
    await staleStore.advance(
      { channelId, payer: getAddress(payer2!.address), cumulativeAmount: "1000", nonce: 0, validUntil: 0, signature: "0x", updatedAt: 0 },
      0n,
    );
    const freshGatekeeper = new Gatekeeper({
      service: "test.mcp",
      rootKey: randomBytes(32),
      provider: ctx.provider,
      chainId: ctx.chainId,
      escrow,
      token,
      tokenSymbol: "cbBTC",
      tokenDecimals: 8,
      publicClient,
      store: staleStore,
      pricing: { default: PRICE },
      minChannelTimeLeft: 60,
    });

    // Challenges are unauthenticated, so they never read the chain: the first hint
    // only knows the (stale) store.
    const challenge = await freshGatekeeper.challenge({ resource: "tool_a", payer: payer2!.address });
    expect(challenge.paymentRequest.cumulativeAmount).toBe((1_000n + PRICE).toString());

    // A voucher below the on-chain floor could never be settled: refuse it.
    const stale: Voucher = { ...settled, cumulativeAmount: 5_000n, nonce: 2n };
    const header = buildAuthorizationHeader(
      challenge.macaroonEncoded,
      proofFromSignedVoucher({ voucher: stale, signature: await evm.accounts[8]!.signTypedData(voucherTypedData(ctx.chainId, escrow, stale)) }),
    );
    const result = await freshGatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("insufficient_payment");
    // Having read the chain while verifying, the next challenge carries the real floor.
    expect(result.challenge.paymentRequest.cumulativeAmount).toBe((10_000n + PRICE).toString());
  });

  it("stops accepting vouchers when the channel close was requested", async () => {
    const { evm, escrow, token } = ctx;
    const publicClient = evm.publicClient as PublicClient;
    const escrowAbiFull = (await import("../../contracts/tools/evm.mjs")).loadArtifact("L402Escrow").abi;
    const hash = await evm.wallets[2]!.writeContract({
      address: escrow,
      abi: escrowAbiFull as never,
      functionName: "requestClose",
      args: [ctx.channelId] as never,
      account: evm.accounts[2]!,
      chain: evm.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const gatekeeper = new Gatekeeper({
      service: "test.mcp",
      rootKey: randomBytes(32),
      provider: ctx.provider,
      chainId: ctx.chainId,
      escrow,
      token,
      tokenSymbol: "cbBTC",
      tokenDecimals: 8,
      publicClient,
      store: ctx.store,
      pricing: { default: PRICE },
      minChannelTimeLeft: 2 * 86_400, // more than the 24h challenge period left after the request
    });
    const challenge = await gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });
    const voucher: Voucher = {
      channelId: ctx.channelId,
      cumulativeAmount: BigInt(challenge.paymentRequest.cumulativeAmount!),
      nonce: 400n,
      validUntil: BigInt(challenge.paymentRequest.validUntil),
    };
    const header = buildAuthorizationHeader(
      challenge.macaroonEncoded,
      proofFromSignedVoucher({ voucher, signature: await ctx.signVoucher(voucher) }),
    );
    const result = await gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("channel_closing");
  });
});

describe("payer binding, signature formats and resync", () => {
  it("rejects a macaroon the client bound to a payer by itself", async () => {
    // A challenge without X-L402-Payer has no payer binding and no spending cap.
    const unbound = await ctx.gatekeeper.challenge({ resource: "tool_a" });
    const selfBound = attenuate(unbound.macaroon, [caveat(CaveatKeys.payer, "=", ctx.payer.toLowerCase())]);
    const bound = await ctx.gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });
    const voucher: Voucher = {
      channelId: ctx.channelId,
      cumulativeAmount: BigInt(bound.paymentRequest.cumulativeAmount!),
      nonce: 500n,
      validUntil: BigInt(bound.paymentRequest.validUntil),
    };
    const header = buildAuthorizationHeader(
      encodeMacaroon(selfBound),
      proofFromSignedVoucher({ voucher, signature: await ctx.signVoucher(voucher) }),
    );
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_macaroon");
  });

  it("rejects ERC-6492 signatures, which the escrow could never verify", async () => {
    const { voucher, signature, challenge } = await validAuthorization("tool_a", { nonce: 501n });
    const wrapped = serializeErc6492Signature({
      address: "0x0000000000000000000000000000000000001234",
      data: "0xdeadbeef",
      signature,
    });
    const header = buildAuthorizationHeader(
      challenge.macaroonEncoded,
      proofFromSignedVoucher({ voucher, signature: wrapped }),
    );
    const result = await ctx.gatekeeper.authorize({ authorization: header, resource: "tool_a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ERC-6492/);
  });

  it("builds challenges for unknown payers without touching the RPC", async () => {
    const publicClient = ctx.evm.publicClient as PublicClient;
    let reads = 0;
    const counting = new Proxy(publicClient, {
      get(target, property, receiver) {
        if (property === "readContract") {
          return (...args: unknown[]) => {
            reads++;
            return (target.readContract as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const gatekeeper = new Gatekeeper({
      service: "test.mcp",
      rootKey: randomBytes(32),
      provider: ctx.provider,
      chainId: ctx.chainId,
      escrow: ctx.escrow,
      token: ctx.token,
      tokenSymbol: "cbBTC",
      tokenDecimals: 8,
      publicClient: counting,
      store: new MemoryVoucherStore(),
      pricing: { default: PRICE },
    });
    for (let i = 0; i < 20; i++) {
      await gatekeeper.challenge({ resource: "tool_a", payer: `0x${randomBytes(20).toString("hex")}` });
    }
    expect(reads).toBe(0);
  });

  it("offers the last accepted voucher so a restarted client can re-synchronize", async () => {
    const challenge = await ctx.gatekeeper.challenge({ resource: "tool_a", payer: ctx.payer });
    const stored = await ctx.store.get(ctx.channelId);
    expect(challenge.paymentRequest.lastVoucher?.cumulativeAmount).toBe(stored!.cumulativeAmount);
    expect(challenge.paymentRequest.lastVoucher?.signature).toBe(stored!.signature);
  });
});
