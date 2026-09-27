/**
 * L402-EL2 escrow tests on a real EVM (in-process EDR).
 *   node --test tools/escrow.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, getAddress, zeroAddress, toFunctionSelector } from "viem";
import { startEvm, CHAIN_ID, loadArtifact } from "./evm.mjs";

/**
 * EDR does not decode our contracts' custom errors: it only reports the 4-byte
 * selector. This map resolves selectors against the compiled ABIs so tests can
 * assert on the error name.
 */
const ERROR_BY_SELECTOR = (() => {
  const map = new Map();
  for (const name of ["L402Escrow", "MockBTC", "MockSmartAccount"]) {
    for (const entry of loadArtifact(name).abi) {
      if (entry.type !== "error") continue;
      map.set(toFunctionSelector(`${entry.name}(${entry.inputs.map((i) => i.type).join(",")})`), entry.name);
    }
  }
  return map;
})();

async function expectRevert(fn, expectedError) {
  let thrown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `the call should have reverted with ${expectedError} but succeeded`);
  const message = String(thrown.message ?? thrown);
  const data = message.match(/return data: (0x[0-9a-fA-F]+)/)?.[1];
  const decoded = data ? ERROR_BY_SELECTOR.get(data.slice(0, 10)) : undefined;
  const actual = decoded ?? message;
  assert.ok(
    actual === expectedError || message.includes(expectedError),
    `expected ${expectedError}, got ${actual}`,
  );
}

const DAY = 24n * 60n * 60n;
const BTC = (n) => BigInt(Math.round(n * 1e8)); // cbBTC has 8 decimals

const VOUCHER_TYPES = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "nonce", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
};

const DELEGATION_TYPES = {
  Delegation: [
    { name: "payer", type: "address" },
    { name: "signer", type: "address" },
    { name: "maxCumulative", type: "uint256" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

function channelIdOf(payer, provider, token) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }],
      [getAddress(payer), getAddress(provider), getAddress(token)],
    ),
  );
}

async function setup() {
  const evm = await startEvm();
  const [owner, payer, provider, sessionKey, treasury, outsider] = evm.accounts;

  const token = await evm.deploy("MockBTC");
  const escrow = await evm.deploy("L402Escrow", [owner.address, treasury.address, 0]);

  const domain = { name: "L402-EL2", version: "1", chainId: CHAIN_ID, verifyingContract: escrow.address };

  const write = (account, functionName, args, contract = escrow) =>
    evm.wallets[evm.accounts.indexOf(account)].writeContract({
      address: contract.address,
      abi: contract.abi,
      functionName,
      args,
    });

  const read = (functionName, args, contract = escrow) =>
    evm.publicClient.readContract({ address: contract.address, abi: contract.abi, functionName, args });

  const mine = async (hash) => evm.publicClient.waitForTransactionReceipt({ hash });

  // Initial funds
  await mine(await write(owner, "mint", [payer.address, BTC(10)], token));

  const now = () => evm.publicClient.getBlock().then((b) => b.timestamp);

  const signVoucher = (account, voucher) =>
    account.signTypedData({ domain, types: VOUCHER_TYPES, primaryType: "Voucher", message: voucher });

  return {
    evm,
    owner,
    payer,
    provider,
    sessionKey,
    treasury,
    outsider,
    token,
    escrow,
    domain,
    write,
    read,
    mine,
    now,
    signVoucher,
  };
}

/** Opens a payer -> provider channel with `amount` deposited. */
async function openChannel(ctx, amount = BTC(1), duration = 30n * DAY) {
  const { payer, provider, token, escrow, write, mine } = ctx;
  await mine(await write(payer, "approve", [escrow.address, amount], token));
  await mine(await write(payer, "openChannel", [provider.address, token.address, amount, duration]));
  return channelIdOf(payer.address, provider.address, token.address);
}

test("openChannel: deposits the funds and derives a deterministic channelId", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx, BTC(1));

  const onchainId = await ctx.read("computeChannelId", [
    ctx.payer.address,
    ctx.provider.address,
    ctx.token.address,
  ]);
  assert.equal(onchainId, channelId, "the channelId computed offline must match the on-chain one");

  const ch = await ctx.read("getChannel", [channelId]);
  assert.equal(ch.deposited, BTC(1));
  assert.equal(ch.claimed, 0n);
  assert.equal(getAddress(ch.payer), getAddress(ctx.payer.address));
  assert.equal(await ctx.read("available", [channelId]), BTC(1));
  assert.equal(await ctx.read("balanceOf", [ctx.escrow.address], ctx.token), BTC(1));
});

test("settle: the provider collects the cumulative delta of the voucher", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx, BTC(1));
  const validUntil = (await ctx.now()) + 3600n;

  // Voucher #1: 0.001 BTC cumulative
  const v1 = { channelId, cumulativeAmount: BTC(0.001), nonce: 1n, validUntil };
  const s1 = await ctx.signVoucher(ctx.payer, v1);
  await ctx.mine(await ctx.write(ctx.provider, "settle", [v1, s1, zeroAddress]));
  assert.equal(await ctx.read("balanceOf", [ctx.provider.address], ctx.token), BTC(0.001));

  // Voucher #2: 0.003 cumulative -> the provider only collects the 0.002 delta
  const v2 = { channelId, cumulativeAmount: BTC(0.003), nonce: 2n, validUntil };
  const s2 = await ctx.signVoucher(ctx.payer, v2);
  await ctx.mine(await ctx.write(ctx.provider, "settle", [v2, s2, zeroAddress]));
  assert.equal(await ctx.read("balanceOf", [ctx.provider.address], ctx.token), BTC(0.003));

  const ch = await ctx.read("getChannel", [channelId]);
  assert.equal(ch.claimed, BTC(0.003));
  assert.equal(await ctx.read("available", [channelId]), BTC(1) - BTC(0.003));
});

test("an old voucher cannot be reused (monotonicity)", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx);
  const validUntil = (await ctx.now()) + 3600n;

  const v1 = { channelId, cumulativeAmount: BTC(0.005), nonce: 1n, validUntil };
  const s1 = await ctx.signVoucher(ctx.payer, v1);
  await ctx.mine(await ctx.write(ctx.provider, "settle", [v1, s1, zeroAddress]));

  await expectRevert(() => ctx.write(ctx.provider, "settle", [v1, s1, zeroAddress]), "VoucherNotMonotonic");
});

test("a voucher cannot drain more than the deposit", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx, BTC(0.01));
  const validUntil = (await ctx.now()) + 3600n;
  const v = { channelId, cumulativeAmount: BTC(5), nonce: 1n, validUntil };
  const s = await ctx.signVoucher(ctx.payer, v);
  await expectRevert(() => ctx.write(ctx.provider, "settle", [v, s, zeroAddress]), "InsufficientChannelBalance");
});

test("signature from an unauthorized third party: rejected", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx);
  const validUntil = (await ctx.now()) + 3600n;
  const v = { channelId, cumulativeAmount: BTC(0.001), nonce: 1n, validUntil };
  const bad = await ctx.signVoucher(ctx.outsider, v);
  await expectRevert(() => ctx.write(ctx.provider, "settle", [v, bad, zeroAddress]), "InvalidSignature");
});

test("expired voucher: rejected", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx);
  const validUntil = (await ctx.now()) + 60n;
  const v = { channelId, cumulativeAmount: BTC(0.001), nonce: 1n, validUntil };
  const s = await ctx.signVoucher(ctx.payer, v);
  await ctx.evm.increaseTime(120);
  await expectRevert(() => ctx.write(ctx.provider, "settle", [v, s, zeroAddress]), "VoucherExpired");
});

test("only the channel provider can settle", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx);
  const validUntil = (await ctx.now()) + 3600n;
  const v = { channelId, cumulativeAmount: BTC(0.001), nonce: 1n, validUntil };
  const s = await ctx.signVoucher(ctx.payer, v);
  await expectRevert(() => ctx.write(ctx.outsider, "settle", [v, s, zeroAddress]), "NotProvider");
});

test("session key: valid within the cap, rejected above it", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx, BTC(1));
  const validUntil = (await ctx.now()) + 3600n;

  // The payer authorizes the agent's session key for at most 0.05 BTC cumulative
  await ctx.mine(
    await ctx.write(ctx.payer, "authorizeSigner", [
      ctx.sessionKey.address,
      BTC(0.05),
      Number((await ctx.now()) + DAY),
    ]),
  );

  const ok = { channelId, cumulativeAmount: BTC(0.04), nonce: 1n, validUntil };
  const sOk = await ctx.signVoucher(ctx.sessionKey, ok);
  await ctx.mine(await ctx.write(ctx.provider, "settle", [ok, sOk, ctx.sessionKey.address]));
  assert.equal(await ctx.read("balanceOf", [ctx.provider.address], ctx.token), BTC(0.04));

  const over = { channelId, cumulativeAmount: BTC(0.06), nonce: 2n, validUntil };
  const sOver = await ctx.signVoucher(ctx.sessionKey, over);
  await expectRevert(() => ctx.write(ctx.provider, "settle", [over, sOver, ctx.sessionKey.address]), "DelegationCapExceeded");
});

test("session key revocation: takes effect only after the grace period", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx);
  await ctx.mine(
    await ctx.write(ctx.payer, "authorizeSigner", [ctx.sessionKey.address, BTC(1), Number((await ctx.now()) + 30n * DAY)]),
  );

  // The agent pays with a session-key voucher, then the payer revokes the key.
  const v = { channelId, cumulativeAmount: BTC(0.001), nonce: 1n, validUntil: (await ctx.now()) + 10n * DAY };
  const s = await ctx.signVoucher(ctx.sessionKey, v);
  await ctx.mine(await ctx.write(ctx.payer, "revokeSigner", [ctx.sessionKey.address]));

  // Inside the grace period the provider can still collect what it was already paid.
  await ctx.mine(await ctx.write(ctx.provider, "settle", [v, s, ctx.sessionKey.address]));
  assert.equal(await ctx.read("balanceOf", [ctx.provider.address], ctx.token), BTC(0.001));

  // After the grace period the key is dead.
  await ctx.evm.increaseTime(Number(DAY) + 1);
  const later = { ...v, cumulativeAmount: BTC(0.002), nonce: 2n };
  const laterSig = await ctx.signVoucher(ctx.sessionKey, later);
  await expectRevert(
    () => ctx.write(ctx.provider, "settle", [later, laterSig, ctx.sessionKey.address]),
    "DelegationExpired",
  );
});

test("session key: a live delegation can be widened but not narrowed", async () => {
  const ctx = await setup();
  const expiry = (await ctx.now()) + 30n * DAY;
  await ctx.mine(await ctx.write(ctx.payer, "authorizeSigner", [ctx.sessionKey.address, BTC(0.05), Number(expiry)]));

  // Lowering the cap or pulling the expiry in would void vouchers already handed out.
  await expectRevert(
    () => ctx.write(ctx.payer, "authorizeSigner", [ctx.sessionKey.address, BTC(0.01), Number(expiry)]),
    "DelegationTightened",
  );
  const soon = (await ctx.now()) + 60n;
  await expectRevert(
    () => ctx.write(ctx.payer, "authorizeSigner", [ctx.sessionKey.address, BTC(0.05), Number(soon)]),
    "DelegationTightened",
  );

  // Widening is always fine.
  await ctx.mine(
    await ctx.write(ctx.payer, "authorizeSigner", [ctx.sessionKey.address, BTC(0.1), Number(expiry + DAY)]),
  );
  const [maxCumulative] = await ctx.read("delegations", [ctx.payer.address, ctx.sessionKey.address]);
  assert.equal(maxCumulative, BTC(0.1));
});

test("delegation signed off-chain (authorizeSignerWithSig)", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx);
  const validUntil = (await ctx.now()) + 3600n;
  const delegationValidUntil = (await ctx.now()) + DAY;

  const message = {
    payer: getAddress(ctx.payer.address),
    signer: getAddress(ctx.sessionKey.address),
    maxCumulative: BTC(0.05),
    validUntil: delegationValidUntil,
    nonce: 0n,
  };
  const sig = await ctx.payer.signTypedData({
    domain: ctx.domain,
    types: DELEGATION_TYPES,
    primaryType: "Delegation",
    message,
  });

  // Anyone (a relayer) can submit the delegation: the signature is the payer's.
  await ctx.mine(
    await ctx.write(ctx.outsider, "authorizeSignerWithSig", [
      message.payer,
      message.signer,
      message.maxCumulative,
      Number(message.validUntil),
      message.nonce,
      sig,
    ]),
  );

  const v = { channelId, cumulativeAmount: BTC(0.01), nonce: 1n, validUntil };
  const s = await ctx.signVoucher(ctx.sessionKey, v);
  await ctx.mine(await ctx.write(ctx.provider, "settle", [v, s, ctx.sessionKey.address]));
  assert.equal(await ctx.read("balanceOf", [ctx.provider.address], ctx.token), BTC(0.01));
});

test("invalidateDelegationNonce: cancels a signed delegation nobody submitted yet", async () => {
  const ctx = await setup();
  const message = {
    payer: getAddress(ctx.payer.address),
    signer: getAddress(ctx.sessionKey.address),
    maxCumulative: BTC(0.05),
    validUntil: (await ctx.now()) + DAY,
    nonce: 0n,
  };
  const sig = await ctx.payer.signTypedData({
    domain: ctx.domain,
    types: DELEGATION_TYPES,
    primaryType: "Delegation",
    message,
  });

  await ctx.mine(await ctx.write(ctx.payer, "invalidateDelegationNonce", []));
  await expectRevert(
    () =>
      ctx.write(ctx.outsider, "authorizeSignerWithSig", [
        message.payer,
        message.signer,
        message.maxCumulative,
        Number(message.validUntil),
        message.nonce,
        sig,
      ]),
    "InvalidSignature",
  );
});

test("ERC-1271 smart account: the escrow accepts vouchers from an ERC-4337 account", async () => {
  const ctx = await setup();
  const { evm, payer, provider, token, escrow, owner } = ctx;

  // The smart account is owned by the payer (acting here as the agent's owner key)
  const sa = await evm.deploy("MockSmartAccount", [payer.address]);
  await ctx.mine(await ctx.write(owner, "mint", [sa.address, BTC(1)], token));

  // Atomic batch: approve + openChannel in a single transaction (the ERC-4337 pattern)
  const approveData = {
    address: token.address,
    abi: token.abi,
    functionName: "approve",
    args: [escrow.address, BTC(1)],
  };
  const openData = {
    address: escrow.address,
    abi: escrow.abi,
    functionName: "openChannel",
    args: [provider.address, token.address, BTC(1), 30n * DAY],
  };
  const { encodeFunctionData } = await import("viem");
  await ctx.mine(
    await ctx.write(payer, "executeBatch", [
      [token.address, escrow.address],
      [encodeFunctionData(approveData), encodeFunctionData(openData)],
    ], sa),
  );

  const channelId = channelIdOf(sa.address, provider.address, token.address);
  assert.equal((await ctx.read("getChannel", [channelId])).deposited, BTC(1));

  // The voucher is signed by the owner key but verified via ERC-1271 on the smart account
  const validUntil = (await ctx.now()) + 3600n;
  const v = { channelId, cumulativeAmount: BTC(0.02), nonce: 1n, validUntil };
  const s = await ctx.signVoucher(payer, v);
  await ctx.mine(await ctx.write(provider, "settle", [v, s, zeroAddress]));
  assert.equal(await ctx.read("balanceOf", [provider.address], token), BTC(0.02));
});

test("settleBatch: a single L2 transaction settles many channels", async () => {
  const ctx = await setup();
  const { evm, owner, provider, token, escrow } = ctx;
  const payers = evm.accounts.slice(6, 9);
  const validUntil = (await ctx.now()) + 3600n;

  const vouchers = [];
  const sigs = [];
  for (const p of payers) {
    await ctx.mine(await ctx.write(owner, "mint", [p.address, BTC(1)], token));
    await ctx.mine(await ctx.write(p, "approve", [escrow.address, BTC(1)], token));
    await ctx.mine(await ctx.write(p, "openChannel", [provider.address, token.address, BTC(1), 30n * DAY]));
    const channelId = channelIdOf(p.address, provider.address, token.address);
    const v = { channelId, cumulativeAmount: BTC(0.01), nonce: 1n, validUntil };
    vouchers.push(v);
    sigs.push(await ctx.signVoucher(p, v));
  }

  await ctx.mine(
    await ctx.write(provider, "settleBatch", [vouchers, sigs, payers.map(() => zeroAddress)]),
  );
  assert.equal(await ctx.read("balanceOf", [provider.address], token), BTC(0.03));
});

test("unilateral close: the payer gets the funds back only after the challenge period", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx, BTC(1), 90n * DAY);

  await expectRevert(() => ctx.write(ctx.payer, "withdraw", [channelId]), "CloseNotRequested");

  await ctx.mine(await ctx.write(ctx.payer, "requestClose", [channelId]));
  await expectRevert(() => ctx.write(ctx.payer, "withdraw", [channelId]), "CloseNotMatured");

  // The provider settles at the last moment, inside the window
  const validUntil = (await ctx.now()) + 3600n;
  const v = { channelId, cumulativeAmount: BTC(0.1), nonce: 9n, validUntil };
  const s = await ctx.signVoucher(ctx.payer, v);
  await ctx.mine(await ctx.write(ctx.provider, "settle", [v, s, zeroAddress]));

  await ctx.evm.increaseTime(Number(DAY) + 1);
  const before = await ctx.read("balanceOf", [ctx.payer.address], ctx.token);
  await ctx.mine(await ctx.write(ctx.payer, "withdraw", [channelId]));
  const after = await ctx.read("balanceOf", [ctx.payer.address], ctx.token);
  assert.equal(after - before, BTC(1) - BTC(0.1));
  assert.equal(await ctx.read("available", [channelId]), 0n);
});

test("after a withdrawal, vouchers from the previous life of the channel are void", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx, BTC(1), 2n * 3600n);
  const validUntil = (await ctx.now()) + 10n * DAY;

  // A voucher signed but never settled by the provider.
  const stale = { channelId, cumulativeAmount: BTC(0.5), nonce: 1n, validUntil };
  const staleSig = await ctx.signVoucher(ctx.payer, stale);

  await ctx.evm.increaseTime(2 * 3600 + 1); // the channel expires naturally
  await ctx.mine(await ctx.write(ctx.payer, "withdraw", [channelId]));
  assert.equal(await ctx.read("cumulativeFloor", [channelId]), BTC(1), "the refund raises the cumulative floor");

  // The same channel is reopened with fresh funds.
  await ctx.mine(await ctx.write(ctx.payer, "approve", [ctx.escrow.address, BTC(1)], ctx.token));
  await ctx.mine(
    await ctx.write(ctx.payer, "openChannel", [ctx.provider.address, ctx.token.address, BTC(1), 30n * DAY]),
  );

  // The stale voucher cannot be cashed against the new deposit...
  await expectRevert(() => ctx.write(ctx.provider, "settle", [stale, staleSig, zeroAddress]), "VoucherNotMonotonic");

  // ...while new vouchers simply continue from the floor.
  const fresh = { channelId, cumulativeAmount: BTC(1) + BTC(0.2), nonce: 2n, validUntil };
  await ctx.mine(await ctx.write(ctx.provider, "settle", [fresh, await ctx.signVoucher(ctx.payer, fresh), zeroAddress]));
  assert.equal(await ctx.read("balanceOf", [ctx.provider.address], ctx.token), BTC(0.2));
  assert.equal(await ctx.read("available", [channelId]), BTC(0.8));
});

test("settleAndClose: settlement + immediate refund in one transaction", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx, BTC(1), 90n * DAY);
  const validUntil = (await ctx.now()) + 3600n;
  const v = { channelId, cumulativeAmount: BTC(0.2), nonce: 4n, validUntil };
  const s = await ctx.signVoucher(ctx.payer, v);

  const payerBefore = await ctx.read("balanceOf", [ctx.payer.address], ctx.token);
  await ctx.mine(await ctx.write(ctx.provider, "settleAndClose", [v, s, zeroAddress]));

  assert.equal(await ctx.read("balanceOf", [ctx.provider.address], ctx.token), BTC(0.2));
  assert.equal((await ctx.read("balanceOf", [ctx.payer.address], ctx.token)) - payerBefore, BTC(0.8));
  assert.equal(await ctx.read("available", [channelId]), 0n);
});

test("protocol fee: withheld and sent to the treasury", async () => {
  const ctx = await setup();
  await ctx.mine(await ctx.write(ctx.owner, "setProtocolFee", [100, ctx.treasury.address])); // 1%
  const channelId = await openChannel(ctx, BTC(1));
  const validUntil = (await ctx.now()) + 3600n;
  const v = { channelId, cumulativeAmount: BTC(0.1), nonce: 1n, validUntil };
  const s = await ctx.signVoucher(ctx.payer, v);
  await ctx.mine(await ctx.write(ctx.provider, "settle", [v, s, zeroAddress]));

  assert.equal(await ctx.read("balanceOf", [ctx.treasury.address], ctx.token), BTC(0.1) / 100n);
  assert.equal(await ctx.read("balanceOf", [ctx.provider.address], ctx.token), BTC(0.1) - BTC(0.1) / 100n);
});

test("opening with ERC-3009 receiveWithAuthorization (third-party relayer)", async () => {
  const ctx = await setup();
  const { payer, provider, token, escrow, outsider } = ctx;
  const amount = BTC(0.5);
  const duration = 30n * DAY;
  const validAfter = 0n;
  const validBefore = (await ctx.now()) + DAY;

  const authNonce = await ctx.read("computeAuthNonce", [
    payer.address,
    provider.address,
    token.address,
    amount,
    Number(duration),
    validBefore,
  ]);

  const tokenDomain = {
    name: "Mock Coinbase Wrapped BTC",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: token.address,
  };
  const authSig = await payer.signTypedData({
    domain: tokenDomain,
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: getAddress(payer.address),
      to: getAddress(escrow.address),
      value: amount,
      validAfter,
      validBefore,
      nonce: authNonce,
    },
  });

  // The relayer pays the gas; the payer signs no transaction
  await ctx.mine(
    await ctx.write(outsider, "openChannelWithAuthorization", [
      payer.address,
      provider.address,
      token.address,
      amount,
      Number(duration),
      validAfter,
      validBefore,
      authNonce,
      authSig,
    ]),
  );

  const channelId = channelIdOf(payer.address, provider.address, token.address);
  assert.equal((await ctx.read("getChannel", [channelId])).deposited, amount);
});

test("ERC-3009: the nonce is bound to the parameters, redirecting to another provider fails", async () => {
  const ctx = await setup();
  const { payer, provider, outsider, token, escrow } = ctx;
  const amount = BTC(0.5);
  const duration = 30n * DAY;
  const validBefore = (await ctx.now()) + DAY;
  const authNonce = await ctx.read("computeAuthNonce", [
    payer.address,
    provider.address,
    token.address,
    amount,
    Number(duration),
    validBefore,
  ]);

  await expectRevert(() =>
      ctx.write(outsider, "openChannelWithAuthorization", [
        payer.address,
        outsider.address, // provider swapped by the attacker
        token.address,
        amount,
        Number(duration),
        0n,
        validBefore,
        authNonce,
        "0x" + "00".repeat(65),
      ]), "InvalidSignature");
});

test("pause blocks new deposits but not settlements and withdrawals", async () => {
  const ctx = await setup();
  const channelId = await openChannel(ctx, BTC(1), 2n * 3600n);
  await ctx.mine(await ctx.write(ctx.owner, "pause", []));

  await ctx.mine(await ctx.write(ctx.payer, "approve", [ctx.escrow.address, BTC(1)], ctx.token));
  await expectRevert(() => ctx.write(ctx.payer, "openChannel", [ctx.provider.address, ctx.token.address, BTC(1), 30n * DAY]), "EnforcedPause");

  const validUntil = (await ctx.now()) + 3600n;
  const v = { channelId, cumulativeAmount: BTC(0.05), nonce: 1n, validUntil };
  const s = await ctx.signVoucher(ctx.payer, v);
  await ctx.mine(await ctx.write(ctx.provider, "settle", [v, s, zeroAddress]));

  await ctx.evm.increaseTime(2 * 3600 + 1);
  await ctx.mine(await ctx.write(ctx.payer, "withdraw", [channelId]));
  assert.equal(await ctx.read("available", [channelId]), 0n);
});
