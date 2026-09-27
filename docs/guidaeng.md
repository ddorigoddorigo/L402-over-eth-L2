# L402-EL2 — In-depth guide

This guide explains how the software works, from the Solidity contract to the AI agent that pays on its own. It is meant for whoever has to maintain the code, extend it or put it into production. Function, type and file names are written exactly as they appear in the code. This is the English version of [`GUIDA.md`](GUIDA.md); both say the same thing.

Contents:

1. [The problem and the idea](#1-the-problem-and-the-idea)
2. [Core concepts](#2-core-concepts)
3. [Monorepo architecture](#3-monorepo-architecture)
4. [The `L402Escrow` contract](#4-the-l402escrow-contract)
5. [`core`: the shared primitives](#5-core-the-shared-primitives)
6. [`server`: the Gatekeeper and the middlewares](#6-server-the-gatekeeper-and-the-middlewares)
7. [`client`: the agent's wallet](#7-client-the-agents-wallet)
8. [`settler`: collecting payments](#8-settler-collecting-payments)
9. [A call from start to finish](#9-a-call-from-start-to-finish)
10. [Deadlines and why they are linked](#10-deadlines-and-why-they-are-linked)
11. [Configuration and going to production](#11-configuration-and-going-to-production)
12. [Tests](#12-tests)
13. [Security model and known limits](#13-security-model-and-known-limits)
14. [Fixed bugs](#14-fixed-bugs)
15. [Glossary](#15-glossary)

---

## 1. The problem and the idea

An AI agent using the tools of an MCP (Model Context Protocol) server can make thousands of calls a day. If each one were an on-chain transaction, even on a cheap Layer 2, the agent would pay more in gas than for the service and would wait for a block (1–2 seconds) on every call.

**L402** is a scheme born on the Lightning Network: the server answers `HTTP 402 Payment Required` with a credential (a *macaroon*) and an invoice; the client pays and repeats the request, attaching the macaroon and a proof of payment. On Lightning the proof is the invoice's *preimage*.

**L402-EL2** brings the same scheme to an Ethereum Layer 2, but replaces the preimage with a **voucher**: an EIP-712 signature on a prefunded **payment channel**. The result:

- the blockchain is touched twice, to **open** the channel and to **collect**;
- in between, each call costs one local signature (under a millisecond, zero gas) and one check on the server (a few milliseconds);
- the token is BTC "wrapped" on the EVM (cbBTC on Base, WBTC on Arbitrum/Optimism, tBTC).

---

## 2. Core concepts

### 2.1 The payment channel

A channel is a deposit by the **payer** (the agent or its owner), locked in a contract in favour of a **provider** (the MCP server), for a given **token**. It is identified by:

```
channelId = keccak256(abi.encode(payer, provider, token))
```

Anyone can compute the `channelId` offline: the client does not need to query the chain to know which channel to sign for.

The channel is **unidirectional**: money only flows from the payer to the provider. The payer can take back what was not spent, but only after a window that protects the provider (§4.6).

### 2.2 The cumulative voucher

A voucher does not say "I pay you 250", it says "**in total** you may take up to 250". The next one says "in total up to 500", and so on.

```
call 1   cumulative voucher = 250
call 2   cumulative voucher = 500
call 3   cumulative voucher = 750   ← the provider only keeps this one
```

Practical consequences:

- the provider keeps **a single voucher per channel**, the latest: settling it collects everything owed in one transaction;
- an old voucher is **useless**: the contract only accepts amounts higher than what was already collected;
- the most a dishonest provider can take is **the highest voucher the payer ever signed** — which is exactly what the payer agreed to pay.

The signed voucher has this shape:

```solidity
Voucher(bytes32 channelId, uint256 cumulativeAmount, uint64 nonce, uint64 validUntil)
```

`nonce` is only a diagnostic counter; `validUntil` is the expiry after which the voucher can no longer be settled.

### 2.3 The macaroon

The macaroon is the HTTP credential the server issues in the 402 response. It is a token with **caveats** (restrictions) and a chained HMAC signature:

```
sig₀ = HMAC(rootKey, identifier)
sig₁ = HMAC(sig₀, "service = mcp.example.com")
sig₂ = HMAC(sig₁, "expires_at <= 1786717539")
...
```

Important properties:

- a caveat **cannot be removed** without breaking the signature (that would require the server's `rootKey`);
- a caveat **can be added** without the `rootKey`: just compute `HMAC(currentSignature, newCaveat)`. This is called **attenuation**. An agent can hand a sub-agent a restricted macaroon (for example "only the `search_web` tool") and the server verifies it without knowing anything about the delegation.

In the protocol the macaroon binds the request to a payer, a channel, a chain, a token, an expiry and a spending cap.

### 2.4 The session key

An agent should not hold the owner's main key. The contract lets the payer **delegate** a throwaway key:

```solidity
escrow.authorizeSigner(sessionKey, maxCumulative, validUntil);
```

The session key signs vouchers instead of the payer, but the contract rejects any voucher whose cumulative amount is above `maxCumulative`. The spending cap is therefore **on-chain**, not a client rule that a compromised process could ignore.

### 2.5 ERC-4337, ERC-1271, ERC-2612, ERC-3009

- **ERC-4337** (account abstraction): the payer can be a *smart account*. Concrete benefit: `approve` + `openChannel` in a single atomic operation.
- **ERC-1271**: smart accounts have no key of their own; the contract verifies their signatures by calling `isValidSignature` on the account. The code uses OpenZeppelin's `SignatureChecker`, which handles both EOAs and smart accounts.
- **ERC-2612** (`permit`) and **ERC-3009** (`receiveWithAuthorization`): allow depositing with a signature instead of `approve` + a transaction.

---

## 3. Monorepo architecture

```
packages/
  contracts/   L402Escrow.sol, mocks, tests (node + Foundry), deploy
  core/        macaroons, EIP-712, L402 headers, ABI, units      ← used by everyone
  server/      Gatekeeper, HTTP/MCP middlewares, voucher stores
  client/      wallets, ChannelManager, L402 fetch, MCP client, ERC-4337
  settler/     batch settlement + CLI
examples/      server.ts, agent.ts, e2e.ts
docs/          SPEC.md (protocol), guidaeng.md (this guide), GUIDA.md (the same in Italian)
```

Dependencies between packages:

```
            ┌──────────┐
            │   core   │  macaroons, headers, EIP-712, ABI
            └────┬─────┘
       ┌─────────┼──────────┐
       ▼         ▼          ▼
  ┌────────┐ ┌────────┐ ┌────────┐
  │ server │ │ client │ │settler │──► also uses server (types and stores)
  └────────┘ └────────┘ └────────┘
       │                     │
       └──── Redis ──────────┘   same voucher store
```

The contract (`contracts`) is independent: the other packages only use its ABI, which lives in `core/src/abi.ts` (a test checks that it matches the compiled one).

Who does what, in steady state:

| Actor | Process | Touches the chain? |
|---|---|---|
| Agent | `client` inside the agent's process | Only to open/top up the channel and register the session key |
| MCP server | `server` (Express + MCP SDK) | Reads only, with a cache |
| Settler | `settler` (separate process, CLI) | Yes: sends `settleBatch` |
| Contract | `L402Escrow` on the L2 | — |

---

## 4. The `L402Escrow` contract

File: `packages/contracts/src/L402Escrow.sol`.

### 4.1 The state of a channel

```solidity
struct Channel {
    address payer;
    address provider;
    address token;
    uint256 deposited;        // total ever deposited
    uint256 claimed;          // total ever collected by the provider
    uint256 refunded;         // total ever returned to the payer
    uint64  expiry;           // after this date the payer can withdraw immediately
    uint64  closeRequestedAt; // ≠ 0 if the payer requested a close
    bool    exists;
}
```

Three numbers really matter:

```
available        = deposited − claimed − refunded     funds still spendable
cumulativeFloor  = claimed + refunded                 where the cumulative counter stands
```

`claimed` and `refunded` **only grow**; they are never reset.

### 4.2 The cumulative counter and the "floor"

The heart of the contract is the internal function `_settle`:

```solidity
uint256 floor = ch.claimed + ch.refunded;
if (voucher.cumulativeAmount <= floor) revert VoucherNotMonotonic();
...
uint256 delta = voucher.cumulativeAmount - floor;
if (delta > ch.deposited - floor) revert InsufficientChannelBalance();
ch.claimed += delta;
```

An example with numbers:

```
deposit 1000                          floor = 0
voucher 300 settled → pays 300        claimed = 300, floor = 300
voucher 450 settled → pays 150        claimed = 450, floor = 450
the payer withdraws the rest (550)    refunded = 550, floor = 1000
the payer reopens with another 1000   deposited = 2000, floor = 1000
an old 700 voucher → rejected (700 ≤ 1000)
a new 1200 voucher → pays 200
```

Why the floor includes `refunded`: if it only counted `claimed`, a voucher signed before the withdrawal and never settled could be settled afterwards, **with the money of the new deposit**. With refunds included in the floor, a withdrawal "closes the books": every voucher signed before it becomes worthless. The client takes this into account by reading `cumulativeFloor` (via `ChannelManager.syncCumulative`) and signing from there upwards.

### 4.3 Opening and topping up

- `openChannel(provider, token, amount, duration)`: pulls the tokens with `transferFrom` (needs a prior `approve`, or an ERC-4337 batch). If the channel already exists, it tops it up and possibly extends its expiry.
- `openChannelWithPermit(...)`: same as above, but first runs `permit` (ERC-2612). The `permit` is inside a `try`: if someone already consumed it (harmless front-running), the deposit goes ahead anyway.
- `openChannelWithAuthorization(...)`: uses `receiveWithAuthorization` (ERC-3009). A relayer can submit it on behalf of the payer. The ERC-3009 nonce must be `computeAuthNonce(payer, provider, token, amount, duration, validBefore)`: this way whoever intercepts the signature cannot use it to open a channel towards a different provider.
- `topUp(channelId, amount, newExpiry)`: adds funds and possibly extends the expiry.

The duration must be between `MIN_CHANNEL_DURATION` (1 hour) and `MAX_CHANNEL_DURATION` (365 days). Any new deposit **cancels a pending close** (`_cancelPendingClose`): if the payer puts money back in, it wants to keep using the channel.

### 4.4 Settlement

- `settle(voucher, signature, signer)`: the provider collects a voucher. `signer = address(0)` means "signed by the payer".
- `settleBatch(vouchers[], signatures[], signers[])`: N channels in one transaction. It is **all or nothing**: a single invalid voucher makes the whole batch fail (the settler handles this case, §8).
- `settleAndClose(...)`: cooperative close. The provider collects the latest voucher and immediately returns the rest to the payer.

Only the channel's provider can settle (`_providerChannel` checks `msg.sender`).

Checks performed by `_settle`, in order:

1. the voucher has not expired (`validUntil >= block.timestamp`);
2. the amount is above the floor;
3. if signed by a session key: the delegation is active, not expired, and the amount is within the cap;
4. the signature (ECDSA or ERC-1271) on the EIP-712 digest is valid;
5. the delta is covered by the deposit.

If a **protocol fee** is configured (`protocolFeeBps`, at most 5%), it is withheld from the delta and sent to `feeRecipient`.

### 4.5 Delegations (session keys)

```solidity
struct Delegation { uint256 maxCumulative; uint64 validUntil; bool active; }
mapping(address payer => mapping(address signer => Delegation)) public delegations;
```

- `authorizeSigner(signer, maxCumulative, validUntil)`: direct call by the payer.
- `authorizeSignerWithSig(payer, signer, maxCumulative, validUntil, nonce, signature)`: the payer signs off-chain, anyone sends the transaction. The `nonce` must be `delegationNonces[payer]` and is incremented.
- `invalidateDelegationNonce()`: increments the nonce, cancelling delegations that were signed but not submitted yet.
- `revokeSigner(signer)`: revokes the key.

**Key rule**: a "live" delegation (active and not expired) can be **widened** immediately (higher cap, later expiry) but **not narrowed** immediately. A revocation (or bringing the expiry forward) only takes effect after `CLOSE_CHALLENGE_PERIOD` (24 hours):

```solidity
function _earliestAllowedDeadline(uint64 current) internal view returns (uint64) {
    uint64 graceEnd = uint64(block.timestamp) + CLOSE_CHALLENGE_PERIOD;
    return current < graceEnd ? current : graceEnd;
}
```

The reason: without this delay a payer could use the service, paying with vouchers signed by the session key, and revoke the key a moment later, making those vouchers unsettleable. The provider would have worked for free.

Beware of a subtlety: the cap is compared with the **cumulative amount of the channel**, not with "how much this key has signed". Therefore:

- it applies separately **to each channel** of the payer;
- after a refund the floor rises, and cumulative amounts with it: the cap may need to be raised.

### 4.6 Closing and withdrawing

- `requestClose(channelId)`: the payer starts a unilateral close.
- `withdraw(channelId)`: the payer withdraws `available` if **(a)** the channel has expired (`expiry <= now`), or **(b)** 24 hours have passed since `requestClose`.

```
requestClose ──────── 24 hours ───────► withdraw possible
      │                                      │
      └──── the provider can still settle ───┘
```

After the withdrawal, `refunded` rises and so does the floor (§4.2), and `expiry` is set to "now".

Beware: at the **natural expiry** the payer can withdraw **without waiting**. The provider must therefore settle before `expiry`. The server refuses vouchers on channels that expire within `minChannelTimeLeft`, and the settler treats the channel expiry as a deadline (§10).

### 4.7 Administration and pause

- `setProtocolFee(bps, recipient)`: owner only, at most 500 bps.
- `pause()` / `unpause()`: pausing blocks **only new deposits**. Settlements and withdrawals always remain possible: the owner cannot freeze user funds.
- Ownership is `Ownable2Step` (transferring ownership requires the new owner to accept).

### 4.8 Events useful for an indexer

`ChannelOpened`, `ChannelToppedUp`, `VoucherSettled` (with `delta` and `fee`), `CloseRequested`, `CloseCancelled`, `ChannelWithdrawn`, `SignerAuthorized`, `SignerRevoked` (with `effectiveAt`), `DelegationNonceInvalidated`, `ProtocolFeeUpdated`.

---

## 5. `core`: the shared primitives

Folder: `packages/core/src/`.

| File | Content |
|---|---|
| `types.ts` | Protocol types (`Voucher`, `PaymentRequest`, `Macaroon`, `PaymentProof`, error codes), caveat operators, `CLOSE_CHALLENGE_PERIOD` |
| `eip712.ts` | EIP-712 domain, `computeChannelId`, `voucherTypedData`, `delegationTypedData`, digests |
| `macaroon.ts` | Minting, attenuation, encoding, signature and caveat verification |
| `header.ts` | Building and parsing the `WWW-Authenticate` and `Authorization` headers, proof validation |
| `abi.ts` | Minimal ABI of `L402Escrow` and ERC-20 |
| `networks.ts` | Wrapped BTC addresses per chain |
| `units.ts` | `parseUnits` / `formatUnits` without floats |

### 5.1 Macaroons in practice

```ts
const m = mintMacaroon({
  rootKey,
  service: "mcp.example.com",
  caveats: [caveat(CaveatKeys.expiresAt, "<=", now + 3600)],
});

// the client, without the rootKey, restricts the macaroon to one tool
const narrow = attenuate(m, [caveat(CaveatKeys.tool, "=", "search_web")]);

// the server verifies signature + caveats against a "context"
verifyMacaroon(rootKey, narrow, { expires_at: now, tool: "search_web" }); // { ok: true }
```

Caveat evaluation rules (`compare` in `macaroon.ts`):

- if both values are integers, the comparison is numeric with `bigint` (no lexicographic mistakes on large numbers);
- otherwise `=` and `!=` compare strings case-insensitively, while `<`, `>` etc. **fail**;
- `in` checks membership in a comma-separated list;
- **fail-closed**: if the caveat uses a key the context does not contain, verification fails.

The caveat format is **canonical**: `key operator value` with exactly one space before and after the operator. The key cannot contain whitespace; the value is everything that follows, character for character. This way a caveat added with `attenuate` survives encoding and decoding unchanged, and the signature stays valid.

`macaroonExpiry(m)` reads the expiry from the `expires_at` caveats: the client uses it to know when to stop reusing a macaroon.

### 5.2 The headers

Challenge (402 response):

```
WWW-Authenticate: L402 macaroon="<b64url>", invoice="<b64url>", payment_request="<b64url>", version="1"
```

Credentials:

```
Authorization: L402 <macaroon_b64url>:<proof_b64url>
```

`decodeProof` validates **every field** of the proof (format of `channelId`, amount as a decimal string, `nonce` and `validUntil` as non-negative integers, hexadecimal signature, `signer` as an address). Malformed input produces a `MacaroonError` with code `malformed_credentials`, which the server turns into a clean 401 response.

### 5.3 Units

Amounts are always in **base units** (satoshis for cbBTC/WBTC, 8 decimals). Never floats:

```ts
parseUnits("0.00001", 8)  // 1000n
formatUnits(1000n, 8)     // "0.00001"
parseUnits("0.000000001", 8) // error: too many decimals, it does not silently truncate
```

---

## 6. `server`: the Gatekeeper and the middlewares

Folder: `packages/server/src/`.

### 6.1 Configuration (`config.ts`)

```ts
const gatekeeper = new Gatekeeper({
  service: "mcp.example.com",
  rootKey,                 // ≥ 32 bytes
  provider,                // address that collects
  chainId, escrow, token, tokenSymbol, tokenDecimals,
  publicClient,            // read-only viem client
  store,                   // MemoryVoucherStore or RedisVoucherStore
  pricing: { default: 100n, resources: { search_web: 250n } },
});
```

Optional parameters and defaults:

| Parameter | Default | Meaning |
|---|---|---|
| `macaroonTtl` | 3600 s | Lifetime of the issued macaroon |
| `voucherTtl` | 86400 s | Suggested voucher expiry (`validUntil` in the payment request) |
| `minVoucherTimeLeft` | 7200 s | Minimum remaining lifetime of a voucher for it to be accepted |
| `minChannelTimeLeft` | 7200 s | Minimum remaining lifetime of the channel and of the session key |
| `macaroonMaxCumulative` | 1000 × highest price | How much a single macaroon can "spend" beyond the current amount |
| `minDeposit` | 1000 × highest price | Deposit suggested to the client |
| `chainCacheTtlMs` | 15000 ms | Lifetime of the on-chain read cache |

`resolveConfig` rejects inconsistent configurations (for example `voucherTtl <= minVoucherTimeLeft`, which would make the server reject the very vouchers it asks for).

### 6.2 The challenge

`gatekeeper.challenge({ resource, payer })` builds the 402:

1. computes the price of the resource;
2. mints a macaroon with the `service`, `chain_id`, `token`, `expires_at` caveats;
3. if it knows the payer (`X-L402-Payer` header), adds `payer`, `channel_id` and `max_cumulative`, and puts in the payment request the **exact cumulative amount** to sign: `max(last accepted, on-chain floor) + price`.

With that amount the client only has to sign, without any RPC call.

Two important details:

- the challenge **never reads the chain**. Anyone can request one with any `X-L402-Payer`: if every request triggered an RPC read, the server would become a traffic amplifier towards the node. The "on-chain floor" used here is only the one already in the cache; if it is too low, the following verification reads the chain and the challenge it sends back is exact;
- if the store already has an accepted voucher for that channel, the payment request includes it in the `lastVoucher` field: it lets a client that lost its state (for example after a restart) re-synchronize (§7.2).

### 6.3 Authorization, step by step

`gatekeeper.authorize({ authorization, resource, payerHint })` runs the checks from the cheapest to the most expensive:

```
 1. header present and well-formed .............. missing_credentials / malformed_credentials
    proof of type "voucher" ...................... invalid_proof
 2. bound to a payer by the server ............... invalid_macaroon
    HMAC signature + all caveats ................. invalid_macaroon / caveat_failed
    macaroon not revoked ......................... revoked
 3. voucher on the right channel ................. invalid_proof
    validUntil ≥ now + minVoucherTimeLeft ........ voucher_expired
 4. if there is a session key: delegation ........ delegation_invalid
    active, still valid for minChannelTimeLeft, within the cap
 5. signature not in ERC-6492 format ............. invalid_signature
    valid EIP-712 signature (EOA or ERC-1271) .... invalid_signature
 6. channel exists ................................ channel_not_found
    does not close within minChannelTimeLeft ...... channel_closing
    amount ≤ deposited ............................ insufficient_deposit
 7. amount ≥ max(last accepted, floor) + price .... insufficient_payment
    atomic advance of the store ................... voucher_not_monotonic
```

Notes on the steps:

- **Bound by the server**: the `channelId` in the macaroon identifier (which is part of the HMAC root and therefore cannot be added later) must match the channel of the `payer` caveat. A macaroon issued without `X-L402-Payer` has neither a payer nor a spending cap; without this check its holder could "bind" it themselves by appending a `payer` caveat, skipping the server's `max_cumulative` cap.
- **Revocation** is checked after the HMAC signature: a forged macaroon never reaches the store.
- **ERC-6492** is the format viem uses to sign for smart accounts that are not deployed yet. viem can verify it off-chain, but the contract (ERC-1271) cannot: such a voucher could never be settled.
- "Does not close within" considers both `expiry` and, if there is a close request, `closeRequestedAt + 24h`.

If a check fails, the result contains a **new challenge**, ready to use: the middleware sends it back to the client, which re-aligns on its own.

If everything passes, the result contains `payer`, `channelId`, `price`, `cumulativeAmount`, `delta` and `remaining` (estimated balance: `deposited − cumulativeAmount`).

### 6.4 `ChainReader` (`chain.ts`)

Reads `getChannel` and `delegations` from the contract with a **short-TTL cache** (15 s) and de-duplicates concurrent reads. The cache has a **size limit** (10,000 entries per kind, evicting the oldest), because channel ids come from requests and an unbounded cache would let anyone grow the server's memory. `peekChannel` returns the last known state without any RPC call: that is what challenges use. It is a deliberate trade-off: verifying a call must stay under ~10 ms. The risk (accepting a voucher a few seconds after an on-chain change) is covered by the fact that everything the payer can do against the provider only takes effect after 24 hours.

### 6.5 Voucher stores (`store/`)

The `VoucherStore` interface:

| Method | Use |
|---|---|
| `get(channelId)` | Latest accepted voucher |
| `advance(voucher, minCumulative)` | Accepts the voucher **only if** it is ≥ `minCumulative` and strictly greater than the current one. **Atomic per channel** |
| `listPending(limit)` | Vouchers with an amount not yet settled (for the settler) |
| `markSettled(channelId, amount)` | Records an on-chain settlement |
| `getSettled(channelId)` | How much has already been settled |
| `revoke` / `isRevoked` | Macaroon revocation |

Why `advance` must be atomic: without it, a client could send 10 parallel requests with the same voucher; all of them would read the same "latest voucher" and pass, and the client would pay for a single call.

- **`MemoryVoucherStore`**: a promise chain per channel serializes the `advance` calls. Fine for development and tests; everything is lost on restart and the settler (a separate process) cannot see it.
- **`RedisVoucherStore`**: `advance` and `markSettled` are **Lua scripts**, executed atomically by Redis. Amounts are uint256 and Lua uses 64-bit doubles, so the scripts compare digit strings left-padded with zeros to 78 characters (for equal lengths, alphabetical order = numeric order).

Redis keys (with a configurable prefix, default `l402`):

```
l402:voucher:<channelId>   latest voucher (JSON with a "padded" field)
l402:settled:<channelId>   settled amount (zero-padded string)
l402:pending               set of channels with something to settle
l402:revoked:<tokenId>     revoked macaroons (with a TTL)
```

### 6.6 The HTTP middleware (`http.ts`)

```ts
app.use("/api", l402Middleware(gatekeeper, { resourceOf: (req) => req.path }));
```

- resources priced at 0 pass without payment;
- on error it answers with the status from `statusFor(code)` (402, 401 or 429), the `WWW-Authenticate` header and a JSON `{ error, message, payment }`;
- on success it sets `req.l402` and the `X-L402-Channel-Balance` and `X-L402-Next-Cumulative` headers.

### 6.7 The paid MCP server (`mcp.ts`)

`createMcpL402App({ gatekeeper, createServer })` creates an Express app with:

- `POST /mcp` protected by `mcpL402Middleware`, then the MCP SDK's Streamable HTTP transport;
- `GET /mcp` and `DELETE /mcp` for existing sessions;
- `GET /.well-known/l402` (discovery) and `GET /health`.

The middleware looks **inside** the JSON-RPC message:

- only `tools/call`, `resources/read` and `prompts/get` are paid (allowlist); `initialize`, `tools/list`, notifications and pings are free;
- the resource name is the tool name (or the resource URI);
- a JSON-RPC batch may contain **at most one** paid call, otherwise the answer is 400;
- errors travel as JSON-RPC with `code: -32402` and the details in `error.data.l402`.

Session handling: a new session is created only by an `initialize` request; an unknown `mcp-session-id` gets 404 (as the MCP specification requires) instead of creating a new transport. Requests whose `Content-Type` is not `application/json` are rejected with 415 before reaching the payment middleware, which could not read their content otherwise.

---

## 7. `client`: the agent's wallet

Folder: `packages/client/src/`.

### 7.1 Wallets (`wallet.ts`, `erc4337.ts`)

All of them implement `L402Wallet`:

```ts
interface L402Wallet {
  address: Address;        // the payer, owner of the channel
  signerAddress: Address;  // who signs the vouchers (different with a session key)
  signVoucher(chainId, escrow, voucher): Promise<Hex>;   // local, zero gas
  sendCalls(calls): Promise<Hex>;                         // on-chain transactions
}
```

| Function | When to use it |
|---|---|
| `createEoaWallet` | Classic private key. Several calls = several transactions in sequence; stops at the first one that fails |
| `createSmartAccountWallet` | Any compatible ERC-4337 client; calls go into a single atomic UserOperation |
| `createBaseSmartAccountWallet` | Ready-to-use Coinbase Smart Wallet, with a bundler and an optional paymaster |
| `createSessionKeyWallet` | Wraps an owner wallet: signs with a throwaway key; `authorize()` and `revoke()` register/revoke the delegation |

### 7.2 `ChannelManager` (`channel.ts`)

Manages the channel towards each provider and signs the vouchers.

```ts
const channels = new ChannelManager({ wallet, publicClient, chainId, escrow, token });
await channels.open(provider, deposit);         // approve (if needed) + openChannel
const snap = await channels.snapshot(provider); // on-chain state
```

The **liability model**: the provider can always settle the highest voucher ever signed. That is why `getCumulative(provider)` tracks **the highest amount signed**, and never goes down.

`signNext(provider, target, options)`:

- computes the real **increment**: `max(0, target − highest signed)`;
- refuses if the increment exceeds `maxIncrement` (an over-billing attempt);
- calls `approve(increment)` for the last check (the budget, on the `fetch` side);
- **reserves** the amount synchronously, *before* awaiting the signature: this way two concurrent calls never count the same increment twice;
- if the server asks for an amount ≤ the highest already signed, it signs without complaint (increment 0: it costs nothing extra). This happens when a previous voucher was rejected, or with parallel calls.

`syncCumulative(provider)` aligns the counter with the on-chain `cumulativeFloor` (useful after a restart).

`topUp(provider, amount)` tops up the channel, running an `approve` first if the allowance is not enough (as `open` does).

**Resuming after a restart** — `adoptServerState(provider, lastVoucher)`. After a restart the local counter starts again from the on-chain floor, but the server may hold vouchers that were accepted and not yet settled. Without re-alignment the server would ask for an amount much higher than the price and the client would refuse every payment until the next settlement. So the client "adopts" the payment request's `lastVoucher`, but **only if it is settleable on-chain anyway**: right channel, not expired, valid signature, signed by the payer, by the current session key, or by a key the payer delegated on-chain with a sufficient cap. Such a voucher is already a debt of the payer: acknowledging it costs nothing, and a dishonest server cannot make one up.

### 7.3 `createL402Fetch` (`fetch.ts`)

It is a `fetch` that pays on its own:

```ts
const l402Fetch = createL402Fetch({ channels, policy, autoTopUp, onPayment });
const res = await l402Fetch("https://api.example.com/search", { method: "POST", body });
```

The flow:

```
request ──► do I already have macaroon and price for this resource?
               │ yes: sign the voucher right away (optimistic payment, 1 round trip)
               ▼
          send ──► 200? done
               │ 402/401
               ▼
          read the challenge ──► policy checks
               │                  (price, provider, escrow, chain, same network as the wallet)
               ▼
          "needs funds" error and autoTopUp enabled? → top up the channel
          error a signature cannot fix? → return the response, without signing
               ▼
          is there a verifiable lastVoucher? → re-align the counter
               ▼
          sign the amount the server asks for (per-call and budget checks on the real increment)
               ▼
          resend (up to 3 attempts) ──► 200: cache macaroon and price
```

The `SpendingPolicy`:

| Field | Effect |
|---|---|
| `maxPricePerCall` | Cap on the advertised price and on the real increment of one call |
| `totalBudget` | Cap on the session's spending (computed on increments, not on prices) |
| `allowedProviders` | Pay only these providers |
| `allowedEscrows` | Accept only these escrows |
| `allowedChainIds` | Accept only these chains |

The errors "a signature cannot fix" are `insufficient_deposit`, `channel_not_found`, `channel_closing` (when automatic top-up is disabled or exhausted) and `delegation_invalid`: signing anyway would raise the debt and eat the budget for a call the server would refuse again. Exceeding the per-call limit or the budget always produces a `PaymentRefused`.

In addition, the client always refuses a challenge that asks for a different chain, escrow or token than the `ChannelManager`'s (the signed voucher would be unusable), and runs all these checks **before** any automatic top-up, so a malicious server cannot make the agent deposit funds towards a provider that is not allowed.

The credentials cache is **per resource**, not just per URL: on MCP every call goes to `POST /mcp`, and using the price of one tool for another would sign wrong vouchers. The cached macaroon is dropped 30 seconds before the expiry read from its caveats.

### 7.4 The MCP client (`mcp.ts`)

```ts
const client = await connectPaidMcpClient({ url, channels, policy });
await client.callTool({ name: "search_web", arguments: { query: "..." } });
```

It injects `createL402Fetch` into the MCP SDK's Streamable HTTP transport: the agent calls the tools as if they were free. `discoverL402Service(url)` reads `/.well-known/l402` to learn prices and parameters before opening the channel.

---

## 8. `settler`: collecting payments

Folder: `packages/settler/src/`. It is a separate process that shares the store (Redis) with the server.

### 8.1 The plan (`plan()`)

It examines **all** pending vouchers (the limit is configurable with `maxScan`). With a fixed page, for example the first 1000, 1000 channels with small, non-urgent amounts would be enough to never look at the others, even those about to expire.

For each voucher:

1. reads the channel's on-chain state (if the read fails, that voucher is skipped with `read_failed` and retried on the next run, without stopping the rest);
2. if the amount is ≤ the on-chain floor, the voucher was already settled (or voided by a refund): it is marked as settled and removed from the pending set;
3. computes the settlement **deadline**: the earliest among the voucher expiry, the channel expiry, the end of the window of a close request, and the session key expiry;
4. if the deadline has passed, it is skipped (`deadline_passed`);
5. it is **urgent** if the deadline is within `expiryBuffer` (default 5400 s);
6. if the amount is below `minSettleAmount` and it is not urgent, it is skipped (`below_threshold`).

The selected vouchers are sorted by deadline (most urgent first) and cut to `batchSize`.

### 8.2 Execution (`settle()`)

1. simulates `settleBatch`;
2. if the simulation fails (a single invalid voucher would make the whole batch fail), simulates **each voucher on its own** and drops the ones that would fail, reporting them in `dropped`;
3. sends the transaction and **checks the receipt status**: if it is `reverted`, it throws an error and marks nothing as settled;
4. marks the vouchers as settled in the store.

`settleIndividually()` does the same with one transaction per channel (more expensive, but it isolates every error).

`startSettlerLoop(settler, intervalMs)` runs `settle()` at regular intervals, never overlapping two runs.

### 8.3 The CLI

```bash
npm run build
npx l402-settler plan   # what it would collect, without sending anything
npx l402-settler once   # one settlement and exit
npx l402-settler loop   # keeps running (SIGINT/SIGTERM to stop it)
```

It reads its configuration from environment variables and automatically loads the `.env` file of the current folder.

---

## 9. A call from start to finish

This is what `examples/e2e.ts` does, with the example's real numbers (prices: `search_web` 250 sat, `heavy_analysis` 2000 sat).

**Setup (on-chain, once)**

1. `MockBTC` and `L402Escrow` are deployed; the agent receives 1 fake cbBTC.
2. The agent creates a session key and registers it: `authorizeSigner(sessionKey, 50_000, now + 1 day)`.
3. The agent opens the channel: `approve` + `openChannel(provider, token, 1_000_000, 30 days)`.

**First call to `search_web` (off-chain)**

4. The client sends `initialize` and `tools/list`: free.
5. The client sends `tools/call search_web` with `X-L402-Payer: <payer>`, without `Authorization`.
6. The server answers 402. The payment request says: `amount = 250`, `cumulativeAmount = 250` (floor 0 + 250), `validUntil = now + 24h`.
7. The client checks the policy, computes an increment of 250 (≤ 5000 per call, within the budget), reserves 250, and signs the voucher `{channelId, 250, nonce 1, validUntil}` with the session key.
8. The client repeats the request with `Authorization: L402 <macaroon>:<proof>`.
9. The server verifies everything (§6.3), runs `advance` on the store (0 → 250), and answers 200 with the tool's result.

**Following calls**

10. The client has macaroon and price in its cache: it signs 500 right away, then 750 (a single round trip each).
11. `heavy_analysis` is a different resource, so no cache: a new 402 with `cumulativeAmount = 750 + 2000 = 2750`, signature, 200.

So far: 4 calls, 2750 sat, **0 transactions**.

**The agent restarts (before settlement)**

12. The agent starts again: a new session key (authorized on-chain), a new `ChannelManager` with its counter at the on-chain floor (0, nothing has been settled yet).
13. It calls `search_web`. The challenge asks for 2750 + 250 = 3000 and contains the 2750 `lastVoucher`, signed by the old session key.
14. The client verifies the signature and that the old key is delegated by the payer, adopts 2750 and signs 3000: it pays **only 250**, not 3000.

**Settlement**

15. The settler finds the 3000 voucher in the store, simulates `settleBatch`, sends **one** transaction. The provider receives 3000 sat; `claimed = 3000`.
16. A second settler run finds nothing to collect (no double settlement).

997,000 sat remain in the channel for the next calls.

---

## 10. Deadlines and why they are linked

The provider can settle a voucher only as long as **all** of these hold: the voucher has not expired, the channel has not been emptied by the payer, the session key (if used) is still valid. The earliest of these dates is the **deadline**.

```
voucher accepted                                                  deadline
        │◄──────────── at least minVoucherTimeLeft/minChannelTimeLeft (2h) ─────────►│
        │                                              │◄──── expiryBuffer (1.5h) ──►│
        │                                              │  the settler treats it as   │
        │                                              │  urgent and collects it     │
```

To avoid working for free, the parameters must satisfy these relations:

| Relation | Why |
|---|---|
| `voucherTtl` > `minVoucherTimeLeft` | Otherwise the server would refuse the vouchers it suggests itself (`resolveConfig` checks it) |
| `expiryBuffer` > settler interval | At least one settler run falls inside the "urgent" window |
| `expiryBuffer` < `minVoucherTimeLeft` and `minChannelTimeLeft` | A freshly accepted voucher is not already urgent |
| `CLOSE_CHALLENGE_PERIOD` (24h) ≫ `chainCacheTtlMs` (15 s) | The server's optimistic cache does not expose the provider |

With the defaults (24h vouchers, 2h margins, 1.5h buffer, settler every hour) every accepted voucher is collected at least 30 minutes before its deadline.

---

## 11. Configuration and going to production

### 11.1 Environment variables (`.env.example`)

| Variable | Used by | Notes |
|---|---|---|
| `CHAIN_ID`, `RPC_URL` | all | 8453 Base, 84532 Base Sepolia, 42161 Arbitrum, 10 Optimism |
| `ESCROW_ADDRESS` | all | Output of the deployment |
| `TOKEN_ADDRESS`, `TOKEN_SYMBOL`, `TOKEN_DECIMALS` | server, settler | cbBTC on Base: `0xcbB7…33Bf`, 8 decimals |
| `SERVICE_NAME`, `PORT` | server | |
| `PROVIDER_PRIVATE_KEY` | server, settler | The wallet that collects: in production, in a KMS/HSM |
| `MACAROON_ROOT_KEY` | server | `openssl rand -hex 32`; rotating it invalidates every macaroon |
| `REDIS_URL`, `REDIS_PREFIX` | server, settler | Mandatory in production: the settler must see the server's vouchers |
| `MIN_SETTLE_AMOUNT`, `SETTLE_BATCH_SIZE`, `SETTLE_INTERVAL_MS`, `SETTLE_EXPIRY_BUFFER` | settler | See §10 |
| `MCP_SERVER_URL`, `AGENT_PRIVATE_KEY`, `BUNDLER_URL`, `DAILY_CAP`, `MAX_PRICE_PER_CALL` | agent | Without `BUNDLER_URL` the agent uses an EOA |
| `DEPLOYER_PRIVATE_KEY`, `ESCROW_OWNER`, `FEE_RECIPIENT`, `PROTOCOL_FEE_BPS`, `CHAIN` | deployment | Empty or `0x` = default value |

The examples and the settler CLI automatically load the `.env` file of the folder they are started from.

### 11.2 Going-to-production sequence

1. `npm install && npm run compile:contracts`
2. Deploy the escrow: `node packages/contracts/tools/deploy.mjs` (or `forge script`).
3. Configure `.env` (escrow, token, keys, Redis).
4. Start the MCP server (use `examples/server.ts` as a template).
5. `npm run build` and start `npx l402-settler loop` next to the server, with the same Redis.
6. On the agent side: `ChannelManager` + `connectPaidMcpClient` with a restrictive `SpendingPolicy` and a capped session key. The session key cap is compared with the channel's cumulative counter: it must be set **above the counter's current value**, as `examples/agent.ts` does (`channels.getCumulative(provider) + dailyCap`). An absolute cap becomes unusable as soon as the channel has spent that amount in total.

### 11.3 Choosing prices

Prices are in base units. With cbBTC (8 decimals) and BTC at $100,000, 1 sat ≈ $0.001. `MIN_SETTLE_AMOUNT = 10000` sat ≈ $10 makes sure a settlement never costs more than it collects (gas on L2 costs fractions of a cent), but the threshold is ignored when a deadline gets close.

---

## 12. Tests

| Command | What it covers |
|---|---|
| `npm run test:contracts` | 21 contract tests on a real in-process EVM (EDR): opening, settlement, monotonicity, deposit, signatures, session keys (cap, delayed revocation, no narrowing), off-chain signed delegations and nonce invalidation, ERC-1271, batches, unilateral close, reopening after a withdrawal, fees, ERC-3009, pause |
| `npx vitest run` | 81 TypeScript tests: macaroons and headers (including proof validation), consistency between the TypeScript ABI and the compiled contract, Gatekeeper with attack scenarios, stores, MCP middleware, client (concurrency, budget, malicious servers, resuming after a restart), settler |
| `REDIS_URL=redis://… npx vitest run` | In addition, 6 Redis store tests on a real Redis |
| `forge test` | 18 Solidity tests, including a fuzz test (needs `forge-std`, see README) |
| `npm run example:e2e` | Full integration: contracts, MCP server, agent with a session key, payments, agent restart, settler |
| `npm run typecheck` | Type checking of every package |

`packages/contracts/tools/evm.mjs` starts an in-process EVM (the same engine as Hardhat Network) exposed as a viem client: that is what makes it possible to test everything without installing nodes or Foundry.

---

## 13. Security model and known limits

### What is guaranteed

- A provider cannot collect more than the latest amount signed by the payer.
- A payer cannot spend the same voucher twice.
- A third party that intercepts a voucher cannot use it: only the channel's provider can settle.
- No replay across different chains or escrows (EIP-712 domain).
- A compromised session key costs at most its cap per channel.
- A payer cannot make vouchers already handed out unsettleable in less than 24 hours (close, revocation, narrowing of the delegation), except by letting the channel reach its natural expiry, which the server and the settler watch.
- Concurrent requests with the same voucher do not get through (atomic store).

### Known limits

- **No audit.** The contract is tested but has not been reviewed by third parties. Do not use it with real funds without an audit.
- **ERC-1271 signatures are revocable.** A smart account can change its signature logic after signing; the contract checks the signature at settlement time. With smart-account payers it is worth settling more often.
- **Slower emergency revocation.** The 24-hour delay on revocation protects the honest provider, but it means a stolen session key stays usable for a day (always within its cap, and only by a provider that knows it).
- **Session key cap per channel.** It is compared with each channel's cumulative amount, not with the key's total spending.
- **First-party caveats only.** The third-party caveats of the macaroon standard are not implemented.
- **Proof `type: "tx"`** is defined but not implemented.
- **Rate limiting** must be added according to your traffic (the `rate_limited` code already exists).
- **Idle MCP sessions** stay in memory until the client closes them.

---

## 14. Fixed bugs

### First review round

#### Contract

| # | Problem | Effect | Fix |
|---|---|---|---|
| C1 | `revokeSigner` and `authorizeSigner` took effect instantly | The payer could use the service with session-key vouchers and then revoke the key (or lower its cap/expiry): the provider could no longer collect | A live delegation can only be widened; revocation and bringing the expiry forward take effect after `CLOSE_CHALLENGE_PERIOD` |
| C2 | The counter floor was only `claimed` | After a withdrawal and a reopening, an old voucher never settled could be settled with the money of the new deposit (the old test checked this as expected behaviour, contradicting the documentation) | The floor is `claimed + refunded`; new `cumulativeFloor` view |
| C3 | A delegation signed off-chain and not submitted could not be cancelled | The payer had no way to take back a given signature | `invalidateDelegationNonce()` |
| C4 | `Deploy.s.sol` converted the fee with `uint16(...)` without checks | `PROTOCOL_FEE_BPS=65536` silently became 0 | Range check |

#### Foundry tests

| # | Problem | Fix |
|---|---|---|
| F1 | 12 tests out of 16 failed even on the original code: `_sign()` makes an external call (`voucherDigest`) that consumed `vm.prank` and `vm.expectRevert` | Signature computed before `vm.prank`; now 18 tests out of 18 pass |

#### Server

| # | Problem | Effect | Fix |
|---|---|---|---|
| S1 | It accepted vouchers that had already expired (30 s backwards tolerance) or that expired within a few seconds | A client could sign vouchers valid for 1 second and use the service for free; with the 300 s TTL and an hourly settler, even an honest client was never collected | `validUntil ≥ now + minVoucherTimeLeft`; suggested TTL 24 h |
| S2 | It did not check the session key expiry against settlement times | Vouchers accepted but no longer settleable | The delegation must be valid for at least `minChannelTimeLeft` |
| S3 | It ignored channel close requests | The payer could request a close and keep using the service, then withdraw after 24 h | "Closes within" considers `closeRequestedAt + 24h` |
| S4 | The required minimum was based on the latest voucher in the store even when it was below the on-chain floor | Vouchers accepted but impossible to settle (store reset or stale) | Minimum = `max(store, on-chain floor) + price`, in the challenge too |
| S5 | A malformed proof (e.g. `cumulativeAmount: "abc"`) raised an unhandled exception | Error 500 instead of 401 | Full validation in `decodeProof` |
| S6 | In an MCP batch only the most expensive call was paid | N tools for the price of one; and a macaroon restricted to one tool could "smuggle" other tools into the batch | At most one paid call per batch |
| S7 | Every POST with an unknown session id or without `initialize` created an MCP transport | Wasted resources, behaviour not compliant with MCP | 404 for unknown sessions, 400 without `initialize` |
| S8 | `RedisVoucherStore.markSettled` ran in several steps | A newer voucher accepted in between could disappear from the pending list and never be settled | Atomic Lua script |
| S9 | The HTTP middleware asked for payment even for resources priced at 0 | Impossible to access them (a voucher with an increment > 0 was required) | Free resources pass |
| S10 | `macaroonMaxCumulative` and `minDeposit` were 0 when the default price was 0 | No cap on macaroons with "free by default, some paid tools" price lists | Defaults computed from the highest price |

#### Settler

| # | Problem | Effect | Fix |
|---|---|---|---|
| T1 | It did not check the receipt status | A failed transaction was recorded as a successful settlement | `receipt.status` check |
| T2 | A single invalid voucher made the batch simulation fail on every run | All settlements blocked | Fallback: per-voucher simulation, dropping the ones that fail |
| T3 | Urgency only looked at the voucher expiry | Expiring or closing channels were not collected in time | Deadline = earliest of voucher, channel, close, session key |
| T4 | Overlapping loop runs if a settlement took longer than the interval | Duplicate transactions | One run at a time |
| T5 | Vouchers already settled on-chain (by other means) stayed pending and made the batch fail | Settlements blocked | Comparison with the on-chain floor |

#### Client

| # | Problem | Effect | Fix |
|---|---|---|---|
| L1 | Two concurrent calls asking for the same amount made the second one throw | Parallel MCP calls failed | Synchronous reservation; signing an amount ≤ the highest is allowed |
| L2 | The budget was checked against the advertised price, not the real increment | A server could ask for a cumulative amount higher than the price and exceed the budget | Check on the increment, atomic with the reservation |
| L3 | Automatic top-up happened before the policy checks | A malicious server could make the agent deposit funds towards a provider that was not allowed | Checks before the top-up |
| L4 | Nothing verified that the challenge was for the wallet's chain/escrow/token | Unusable signatures, bypassable policy checks | Explicit refusal |
| L5 | The optimistic payment used a fixed 300 s expiry | With the new server rules it would have been rejected | Uses the TTL indicated by the server |
| L6 | `undefined` options overwrote the `ChannelManager` defaults | Silently wrong configuration | Defaults with `??` |
| L7 | The EOA wallet did not stop on a failed transaction; the ERC-4337 one ignored failed UserOperations | `openChannel` sent even if `approve` had failed | Outcome check |
| L8 | The `paymaster` option of `createBaseSmartAccountWallet` had a nonsensical type and was not used | Impossible to configure a paymaster | Passed to the bundler client |

#### Tooling and examples

| # | Problem | Fix |
|---|---|---|
| E1 | The examples and the CLI never loaded the `.env` file the README asked to fill in | `process.loadEnvFile()` |
| E2 | `deploy.mjs` used `??`: the `0x` placeholder of `.env.example` was passed as an address | Empty and `0x` treated as "not set", addresses validated |
| E3 | The README said `forge install` but the remappings point to `node_modules` | Instructions fixed |
| E4 | The `Caveat.op` type did not include `!=` and `in`, although they were supported | Single `CaveatOp` type |
| E5 | A test on macaroon expiry actually checked a "not before" caveat | Test rewritten with `expires_at <=` |

### Second review round

| # | Problem | Effect | Fix |
|---|---|---|---|
| R1 | Challenges (unauthenticated) read the chain for every `X-L402-Payer`, and the read cache had no limit. The problem had been introduced by fix S4 of the first round | Anyone could make the server issue one RPC call per request and grow its memory without bound | Challenges only use cached state; cache limited to 10,000 entries |
| R2 | The server accepted ERC-6492 signatures (smart accounts not deployed yet) | Vouchers accepted but impossible to settle: the contract verifies with ERC-1271 | ERC-6492 signatures refused |
| R3 | A macaroon issued without a payer could be "bound" by the client itself by appending a `payer` caveat | The server's `max_cumulative` cap was skipped | The identifier's `channelId` (signed by the server) must match the payer |
| R4 | Revocation was checked before the HMAC signature | Forged macaroons reached the store | Revocation checked after the signature |
| R5 | After an agent restart with vouchers not yet settled, every payment was refused ("increment too high" or "budget exhausted") until the provider's next settlement | Agent stuck; reproduced with the e2e on the previous code | `lastVoucher` field in the payment request and verified adoption on the client side |
| R6 | With errors a signature cannot fix (insufficient deposit without top-up, invalid session key) the client signed up to 3 vouchers | Debt and budget consumed for calls that were refused anyway | The client returns the response immediately |
| R7 | Exceeding the per-call limit raised a generic `Error`, not a `PaymentRefused` | The agent could not tell it apart from other policy refusals | Always `PaymentRefused` |
| R8 | Caveat parsing accepted multiple spaces and "normalized" them | A caveat with leading spaces in its value, added with `attenuate`, invalidated the macaroon after decoding | Canonical format with a single space; keys without whitespace |
| R9 | `ChannelManager.topUp` never ran `approve` | Topping up failed when the allowance was not enough | `approve` when needed, as in `open` |
| R10 | The settler only examined the first 1000 pending vouchers | 1000 small, non-urgent channels blocked forever the examination of the others, even those about to expire | Examines all vouchers (`maxScan` configurable) |
| R11 | An RPC error on a single channel made the whole settler run fail | No settlement until the read worked again | The voucher is skipped (`read_failed`) and retried on the next run |
| R12 | `examples/agent.ts` authorized the session key with an absolute cap (`DAILY_CAP`) | As soon as the channel had spent `DAILY_CAP` in total, every new run of the agent could no longer pay | Cap = the channel's current counter + `DAILY_CAP` |
| R13 | The MCP server relied on the SDK to reject non-JSON bodies, which the payment middleware cannot read | No bypass found (the SDK answers 415), but the protection depended on an internal detail | Explicit 415 before the middleware |

Checked and not changed: the `Deploy.s.sol` script with the `0x` placeholder of `.env.example` already works (Foundry uses the default value when it cannot read the address).

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **402 Payment Required** | HTTP status with which the server asks for a payment |
| **Attenuation** | Adding caveats to a macaroon without the server's key |
| **Caveat** | A restriction inside a macaroon (`key operator value`) |
| **Challenge** | The 402 response with macaroon and payment request |
| **Channel** | A payer → provider deposit for one token |
| **Cumulative floor** | `claimed + refunded`: the next voucher must exceed it |
| **Deadline** | The last moment a voucher can be settled |
| **EIP-712** | Standard for signing structured data in a readable way that cannot be reused elsewhere |
| **Gatekeeper** | The server component that issues challenges and verifies payments |
| **Macaroon** | Credential with a chained HMAC signature and caveats |
| **MCP** | Model Context Protocol: the protocol through which agents use servers' tools |
| **Payer / provider** | Who pays / who collects |
| **Payment request** | The EVM equivalent of the Lightning invoice, inside the challenge |
| **Session key** | Delegated key that signs vouchers within an on-chain cap |
| **Settler** | The service that settles vouchers on-chain |
| **Voucher** | Signed authorization to collect a cumulative total |
