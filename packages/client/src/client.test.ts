import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Address, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildChallengeHeader,
  computeChannelId,
  mintMacaroon,
  proofFromSignedVoucher,
  voucherTypedData,
  type PaymentRequest,
} from "@l402-el2/core";

import { ChannelManager } from "./channel.js";
import { createL402Fetch, PaymentRefused } from "./fetch.js";
import type { L402Wallet } from "./wallet.js";

const PAYER = "0x1111111111111111111111111111111111111111" as Address;
const PROVIDER = "0x2222222222222222222222222222222222222222" as Address;
const ESCROW = "0x3333333333333333333333333333333333333333" as Address;
const TOKEN = "0x4444444444444444444444444444444444444444" as Address;
const CHAIN_ID = 84532;

function fakeChannels(): ChannelManager {
  const wallet: L402Wallet = {
    address: PAYER,
    signerAddress: PAYER,
    signVoucher: async () => `0x${"ab".repeat(65)}` as Hex,
    sendCalls: vi.fn(async () => "0x" as Hex),
  };
  return new ChannelManager({
    wallet,
    publicClient: {} as PublicClient,
    chainId: CHAIN_ID,
    escrow: ESCROW,
    token: TOKEN,
  });
}

function challengeResponse(overrides: Partial<PaymentRequest> = {}, error = "missing_credentials"): Response {
  const request: PaymentRequest = {
    scheme: "l402-el2",
    version: 1,
    chainId: CHAIN_ID,
    escrow: ESCROW,
    token: TOKEN,
    tokenSymbol: "cbBTC",
    tokenDecimals: 8,
    provider: PROVIDER,
    amount: "100",
    cumulativeAmount: "100",
    validUntil: Math.floor(Date.now() / 1000) + 86_400,
    ...overrides,
  };
  const macaroon = mintMacaroon({ rootKey: randomBytes(32), service: "test" });
  return new Response(JSON.stringify({ error }), {
    status: 402,
    headers: { "www-authenticate": buildChallengeHeader(macaroon, request) },
  });
}

describe("ChannelManager.signNext", () => {
  it("handles concurrent signatures for the same target without throwing", async () => {
    const channels = fakeChannels();
    const [a, b] = await Promise.all([channels.signNext(PROVIDER, 100n), channels.signNext(PROVIDER, 100n)]);
    expect(a.increment + b.increment).toBe(100n); // the liability is counted once
    expect(channels.getCumulative(PROVIDER)).toBe(100n);
    expect(a.voucher.nonce).not.toBe(b.voucher.nonce);
  });

  it("reserves amounts synchronously, so concurrent increments stack up", async () => {
    const channels = fakeChannels();
    await Promise.all([
      channels.signNext(PROVIDER, channels.getCumulative(PROVIDER) + 100n),
      channels.signNext(PROVIDER, channels.getCumulative(PROVIDER) + 100n),
    ]);
    // The first call reserved 100 before awaiting its signature, so the second one
    // (started while the first was still signing) already builds on top of it.
    expect(channels.getCumulative(PROVIDER)).toBe(200n);
  });

  it("refuses an increment above the limit", async () => {
    const channels = fakeChannels();
    await expect(channels.signNext(PROVIDER, 1_000n, { maxIncrement: 500n })).rejects.toThrow(/too high/);
    expect(channels.getCumulative(PROVIDER)).toBe(0n);
  });
});

describe("createL402Fetch", () => {
  it("pays a 402 and retries", async () => {
    const channels = fakeChannels();
    const baseFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const payments: bigint[] = [];
    const l402Fetch = createL402Fetch({
      channels,
      policy: { maxPricePerCall: 1_000n, totalBudget: 10_000n },
      fetch: baseFetch,
      onPayment: ({ amount }) => payments.push(amount),
    });

    const response = await l402Fetch("http://server.test/tool", { method: "POST" });
    expect(response.status).toBe(200);
    expect(payments).toEqual([100n]);
    const retried = baseFetch.mock.calls[1]![1]!.headers as Headers;
    expect(retried.get("authorization")).toMatch(/^L402 /);
  });

  it("never auto-deposits towards a provider the policy does not allow", async () => {
    const channels = fakeChannels();
    const open = vi.spyOn(channels, "open");
    const evil = "0x9999999999999999999999999999999999999999" as Address;
    const l402Fetch = createL402Fetch({
      channels,
      policy: { maxPricePerCall: 1_000n, totalBudget: 10_000n, allowedProviders: [PROVIDER] },
      fetch: vi.fn<typeof fetch>().mockResolvedValue(challengeResponse({ provider: evil }, "channel_not_found")),
      autoTopUp: { amount: 1_000_000n },
    });

    await expect(l402Fetch("http://server.test/tool")).rejects.toBeInstanceOf(PaymentRefused);
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses challenges for another escrow or token than the wallet's", async () => {
    const channels = fakeChannels();
    const l402Fetch = createL402Fetch({
      channels,
      policy: { maxPricePerCall: 1_000n, totalBudget: 10_000n },
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        challengeResponse({ escrow: "0x5555555555555555555555555555555555555555" }),
      ),
    });
    await expect(l402Fetch("http://server.test/tool")).rejects.toThrow(/this wallet pays/);
  });

  it("checks the budget against the real increment, not the advertised price", async () => {
    const channels = fakeChannels();
    // The server advertises a price of 100 but asks for a cumulative amount of 900.
    const l402Fetch = createL402Fetch({
      channels,
      policy: { maxPricePerCall: 1_000n, totalBudget: 500n },
      fetch: vi.fn<typeof fetch>().mockResolvedValue(challengeResponse({ cumulativeAmount: "900" })),
    });
    await expect(l402Fetch("http://server.test/tool")).rejects.toThrow(/Budget exhausted/);
    expect(channels.getCumulative(PROVIDER)).toBe(0n);
  });
});

describe("recovery and unpayable challenges", () => {
  const owner = privateKeyToAccount(`0x${"42".repeat(32)}`);
  const stranger = privateKeyToAccount(`0x${"43".repeat(32)}`);

  function realChannels(): ChannelManager {
    const wallet: L402Wallet = {
      address: owner.address,
      signerAddress: owner.address,
      signVoucher: (chainId, escrow, voucher) => owner.signTypedData(voucherTypedData(chainId, escrow, voucher)),
      sendCalls: vi.fn(async () => "0x" as Hex),
    };
    return new ChannelManager({ wallet, publicClient: {} as PublicClient, chainId: CHAIN_ID, escrow: ESCROW, token: TOKEN });
  }

  async function serverVoucher(signer: typeof owner, cumulativeAmount: bigint) {
    const voucher = {
      channelId: computeChannelId(owner.address, PROVIDER, TOKEN),
      cumulativeAmount,
      nonce: 9n,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 86_400),
    };
    const signature = await signer.signTypedData(voucherTypedData(CHAIN_ID, ESCROW, voucher));
    const proof = proofFromSignedVoucher({ voucher, signature });
    if (proof.type !== "voucher") throw new Error("unreachable");
    const { type: _type, ...serialized } = proof;
    return serialized;
  }

  it("re-synchronizes after a restart from a voucher it can verify, without counting it as new spending", async () => {
    const channels = realChannels(); // fresh process: local counter at 0
    const lastVoucher = await serverVoucher(owner, 25_000n);
    const payments: bigint[] = [];
    const l402Fetch = createL402Fetch({
      channels,
      policy: { maxPricePerCall: 1_000n, totalBudget: 1_000n },
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(challengeResponse({ cumulativeAmount: "25100", lastVoucher }, "missing_credentials"))
        .mockResolvedValueOnce(new Response("ok")),
      onPayment: ({ amount }) => payments.push(amount),
    });

    expect((await l402Fetch("http://server.test/tool")).status).toBe(200);
    expect(payments).toEqual([100n]); // only the new call, not the 25 000 already owed
    expect(channels.getCumulative(PROVIDER)).toBe(25_100n);
  });

  it("does not adopt a voucher signed by someone else", async () => {
    const channels = realChannels();
    const forged = await serverVoucher(stranger, 25_000n);
    const l402Fetch = createL402Fetch({
      channels,
      policy: { maxPricePerCall: 1_000n, totalBudget: 100_000n },
      fetch: vi.fn<typeof fetch>().mockResolvedValue(challengeResponse({ cumulativeAmount: "25100", lastVoucher: forged })),
    });
    await expect(l402Fetch("http://server.test/tool")).rejects.toBeInstanceOf(PaymentRefused);
    expect(channels.getCumulative(PROVIDER)).toBe(0n);
  });

  it("does not sign when the server says the channel cannot be paid", async () => {
    const channels = fakeChannels();
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(challengeResponse({}, "insufficient_deposit"));
    const l402Fetch = createL402Fetch({ channels, policy: { maxPricePerCall: 1_000n, totalBudget: 10_000n }, fetch: baseFetch });

    const response = await l402Fetch("http://server.test/tool");
    expect(response.status).toBe(402);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(channels.getCumulative(PROVIDER)).toBe(0n); // nothing signed, budget untouched
  });
});
