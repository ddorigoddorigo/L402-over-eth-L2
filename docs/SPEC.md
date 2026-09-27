# L402-EL2 — Protocol specification

Version 1. EVM profile of the L402 protocol for payments in ERC-20 tokens (typically wrapped BTC) on Ethereum Layer 2.

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **payer** | Owner of the channel and of the funds. An EOA or an ERC-4337 smart account. |
| **signer** | Whoever actually signs the vouchers. Either the payer, or a delegated session key. |
| **provider** | The MCP/HTTP server that gets paid. |
| **escrow** | The `L402Escrow` contract on the L2. |
| **channel** | The prefunded payer → provider relationship for a given token. |
| **voucher** | Off-chain signed authorization to collect a cumulative total. |
| **macaroon** | HTTP credential with caveats, issued by the provider. |
| **cumulative floor** | `claimed + refunded` of a channel: where its cumulative counter stands on-chain. |

---

## 2. Channel identifier

```
channelId = keccak256(abi.encode(payer, provider, token))
```

Deterministic and computable offline by both parties. A channel that is closed and reopened keeps the same `channelId`. Since neither `claimed` nor `refunded` is ever reset, and both count towards the cumulative floor, vouchers signed before a withdrawal can never be settled against funds deposited afterwards.

---

## 3. Voucher

### 3.1 EIP-712 domain

```json
{
  "name": "L402-EL2",
  "version": "1",
  "chainId": <L2 chain id>,
  "verifyingContract": <escrow address>
}
```

Binding the domain to chain and contract prevents replaying a voucher on another network or on a different escrow.

### 3.2 Structure

```solidity
struct Voucher {
    bytes32 channelId;
    uint256 cumulativeAmount;  // total authorized, in token base units
    uint64  nonce;             // monotonic counter (ordering and diagnostics)
    uint64  validUntil;        // unix expiry
}
```

```
Voucher(bytes32 channelId,uint256 cumulativeAmount,uint64 nonce,uint64 validUntil)
```

### 3.3 Validity rules (on-chain)

A voucher can be settled if and only if:

1. `validUntil >= now`;
2. `cumulativeAmount > floor`, where `floor = channel.claimed + channel.refunded`;
3. `cumulativeAmount <= channel.deposited` (i.e. `cumulativeAmount - floor <= available`);
4. the signature is valid for `signer` — ECDSA for EOAs, ERC-1271 for smart accounts (checked **at settlement time**);
5. if `signer != payer`, there is an active delegation with `validUntil >= now` and `maxCumulative >= cumulativeAmount`.

Settling pays out `cumulativeAmount - floor` (minus the protocol fee) and raises `claimed` by the same delta.

### 3.4 Acceptance rules (server)

The server only accepts vouchers it will be able to settle later. On top of the rules above, evaluated against the current time plus safety margins, it adds:

6. `validUntil >= now + minVoucherTimeLeft` (default 2 hours);
7. the channel closes no earlier than `now + minChannelTimeLeft` (default 2 hours), where "closes" is the earlier of `expiry` and `closeRequestedAt + CLOSE_CHALLENGE_PERIOD` if a close was requested;
8. for session keys, the delegation's `validUntil >= now + minChannelTimeLeft`;
9. `cumulativeAmount >= max(lastAccepted, onChainFloor) + resourcePrice` — a rule the contract cannot know.

---

## 4. Delegation (session key)

```solidity
struct Delegation {
    uint256 maxCumulative;  // cap on the cumulative amount of any channel of the payer
    uint64  validUntil;
    bool    active;
}
```

It can be registered in two ways:

- `authorizeSigner(signer, maxCumulative, validUntil)` — direct call by the payer (or by its smart account through a UserOperation);
- `authorizeSignerWithSig(payer, signer, maxCumulative, validUntil, nonce, signature)` — the payer's EIP-712 signature, transaction sent by anyone.

Signed structure:

```
Delegation(address payer,address signer,uint256 maxCumulative,uint64 validUntil,uint256 nonce)
```

The `nonce` is sequential per payer (`delegationNonces`) and prevents replaying an old delegation. `invalidateDelegationNonce()` bumps it, cancelling every signed delegation that was not submitted yet.

### 4.1 Changing or revoking a live delegation

Vouchers signed by a session key may still be waiting to be settled, so the payer cannot void them instantly:

- a live delegation (active and not expired) can be **widened** at once: higher `maxCumulative`, later `validUntil`;
- lowering the cap reverts with `DelegationTightened`; moving `validUntil` earlier is allowed only down to `now + CLOSE_CHALLENGE_PERIOD`;
- `revokeSigner(signer)` sets `validUntil = min(validUntil, now + CLOSE_CHALLENGE_PERIOD)` and emits `SignerRevoked(payer, signer, effectiveAt)`.

---

## 5. HTTP headers

### 5.1 Challenge — `WWW-Authenticate`

Sent with status **402 Payment Required** (or **401** when the credentials are broken, see §8):

```
WWW-Authenticate: L402 macaroon="<b64url>", invoice="<b64url>", payment_request="<b64url>", version="1"
```

`invoice` and `payment_request` carry the same value; the former exists for compatibility with pre-existing L402 parsers.

### 5.2 Payment request

JSON serialized as base64url:

```jsonc
{
  "scheme": "l402-el2",
  "version": 1,
  "chainId": 8453,
  "escrow": "0x…",
  "token": "0x…",
  "tokenSymbol": "cbBTC",
  "tokenDecimals": 8,
  "provider": "0x…",
  "amount": "250",              // price of this single call
  "cumulativeAmount": "1750",   // optional: present when the server knows the payer
  "channelId": "0x…",           // optional, same as above
  "validUntil": 1786717539,     // suggested voucher expiry (now + voucherTtl, default 24h)
  "minDeposit": "100000",       // optional, a hint
  "description": "search_web",  // optional
  "lastVoucher": { … }          // optional: latest voucher accepted on this channel (same fields as the proof in §5.3, without "type")
}
```

`lastVoucher` lets a client that lost its local state (e.g. after a restart) re-synchronize. A client MUST NOT trust it blindly: it may adopt it as already-owed only if it targets its own channel, has not expired, carries a valid signature, and was signed by the payer or by a signer with an active delegation covering the amount — i.e. only if it is settleable on-chain anyway.

A client MUST refuse a payment request whose `chainId`, `escrow` or `token` differ from the ones it signs for.

### 5.3 Credentials — `Authorization`

```
Authorization: L402 <macaroon_b64url>:<proof_b64url>
```

Proof (base64url of JSON):

```jsonc
{
  "type": "voucher",
  "channelId": "0x…",           // 32-byte hex
  "cumulativeAmount": "1750",   // decimal string, uint256
  "nonce": 7,                   // non-negative safe integer
  "validUntil": 1786717539,     // non-negative safe integer
  "signature": "0x…",
  "signer": "0x…"               // optional: present only with a session key
}
```

Every field is validated when decoding; a malformed proof yields `malformed_credentials`. Signatures wrapped in ERC-6492 (smart accounts not deployed yet) are refused with `invalid_signature`: the escrow verifies signatures with ERC-1271 at settlement time and cannot unwrap them. The `type` field is extensible: `{"type":"tx", "txHash":"0x…", "payer":"0x…"}` is also defined for a future pay-per-transaction profile; this implementation rejects it.

### 5.4 Auxiliary headers

| Header | Direction | Meaning |
|---|---|---|
| `X-L402-Payer` | client → server | Payer address; lets the server issue a challenge already bound to the channel |
| `X-L402-Channel-Balance` | server → client | Estimated remaining channel balance |
| `X-L402-Next-Cumulative` | server → client | Cumulative amount expected at the next call |

### 5.5 Discovery

```
GET /.well-known/l402
```

```jsonc
{
  "scheme": "l402-el2", "version": 1,
  "service": "mcp.example.com",
  "chainId": 8453,
  "escrow": "0x…", "token": "0x…", "tokenSymbol": "cbBTC", "tokenDecimals": 8,
  "provider": "0x…",
  "minDeposit": "100000",
  "voucherTtl": 86400,
  "minVoucherTimeLeft": 7200,
  "minChannelTimeLeft": 7200,
  "pricing": { "default": "100", "resources": { "search_web": "250" } },
  "payerHeader": "X-L402-Payer"
}
```

---

## 6. Macaroon

### 6.1 Signature chain

```
sig₀ = HMAC-SHA256(rootKey, canonicalIdentifier)
sigᵢ = HMAC-SHA256(sigᵢ₋₁, serialize(caveatᵢ))
```

`canonicalIdentifier` is a JSON with a fixed key order: `{v, service, tokenId, channelId}`.

No caveat can be removed or modified without invalidating the final signature. Anyone holding the macaroon can however **append** caveats — that is attenuation, and it does not require the root key.

### 6.2 Serialization

Base64url of:

```json
{ "i": <identifier>, "c": ["expires_at <= 1786717539", "…"], "s": "<hex>" }
```

A caveat is the string `key operator value`, with exactly one space on each side of the operator (the key has no whitespace, the value is everything after the second space, verbatim). Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `in` (comma-separated list).

### 6.3 Standard caveats

| Key | Example | Checked against |
|---|---|---|
| `service` | `service = mcp.example.com` | service name |
| `chain_id` | `chain_id = 8453` | configured chain |
| `token` | `token = 0x…` | configured token |
| `expires_at` | `expires_at <= 1786717539` | current timestamp |
| `payer` | `payer = 0x…` | channel payer |
| `channel_id` | `channel_id = 0x…` | voucher channel |
| `max_cumulative` | `max_cumulative <= 250000` | voucher `cumulativeAmount` |
| `tool` | `tool in search_web,summarize` | requested resource |

### 6.4 Binding

A macaroon is valid for a paid request only if the server bound it to the payer when minting it: its identifier's `channelId` (part of the HMAC root, so it cannot be added later) must equal the channel derived from its `payer` caveat. Macaroons minted without `X-L402-Payer` are only good for discovering the price.

### 6.5 Evaluation

Numeric comparisons use `bigint`: `max_cumulative <= 100000000000000000000` must reject `100000000000000000001`, which a lexicographic comparison would get wrong. Non-numeric values support `=` and `!=` (case-insensitive); ordering operators on them fail.

Evaluation is **fail-closed**: a caveat whose key is not in the context makes the verification fail. A server that cannot evaluate a restriction must not declare it satisfied.

---

## 7. Flow

### 7.1 First call

```
Client                                        Server
  │  POST /mcp  {tools/call search_web}
  │  X-L402-Payer: 0xAgent…                     │
  ├────────────────────────────────────────────►│
  │                                              │ no credentials
  │  402 + WWW-Authenticate: L402 …              │ mints the macaroon,
  │◄─────────────────────────────────────────────┤ computes cumulativeAmount
  │
  │  local EIP-712 signature (0 gas, <1 ms)
  │
  │  POST /mcp  + Authorization: L402 mac:proof  │
  ├────────────────────────────────────────────►│ checks: macaroon, caveats,
  │                                              │ signature, on-chain channel
  │                                              │ (cached), atomic advance
  │  200 + tool result                           │
  │◄─────────────────────────────────────────────┤
```

### 7.2 Following calls

The client keeps macaroon and price per resource and attaches the voucher **to the very first request**: a single round trip. The 402 comes back when the macaroon expires, the price changes or the server loses its state — and then the payment request re-aligns the client.

On MCP, a JSON-RPC batch may contain at most one paid call (`tools/call`, `resources/read`, `prompts/get`); otherwise the server answers HTTP 400 / JSON-RPC `-32600`. Requests whose `Content-Type` is not `application/json` are refused with 415 before any payment logic runs.

Building a challenge never reads the chain (challenges are unauthenticated). The `cumulativeAmount` hint uses the store and the last cached on-chain state; if it is too low, the failed `authorize` reads the chain and the next challenge is exact.

### 7.3 Settlement

The provider keeps a single voucher per channel in Redis. The settler collects it when the pending amount exceeds `MIN_SETTLE_AMOUNT`, or when its **settlement deadline** — the earliest of voucher expiry, channel expiry, end of a close challenge period and session key expiry — is closer than `expiryBuffer`. It groups up to `SETTLE_BATCH_SIZE` channels in one `settleBatch`, most urgent first. If the batch simulation fails, vouchers are simulated one by one and the failing ones are left out, so one bad voucher never blocks the others.

---

## 8. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `missing_credentials` | 402 | No `Authorization` header |
| `malformed_credentials` | 401 | Header or proof cannot be parsed / validated |
| `invalid_macaroon` | 401 | Invalid HMAC signature, or macaroon not bound to a payer |
| `caveat_failed` | 401 | A caveat is not satisfied |
| `revoked` | 401 | Macaroon revoked |
| `invalid_proof` | 402 | Unsupported proof type, or wrong channel |
| `invalid_signature` | 402 | Invalid voucher signature |
| `voucher_expired` | 402 | `validUntil` passed, or too close to be settled |
| `voucher_not_monotonic` | 402 | Voucher already used |
| `insufficient_payment` | 402 | Amount below the resource price |
| `insufficient_deposit` | 402 | The channel does not cover the amount |
| `channel_not_found` | 402 | No open channel |
| `channel_closing` | 402 | The channel expires or closes too soon to guarantee settlement |
| `delegation_invalid` | 402 | Session key missing, expiring/revoked, or above its cap |
| `rate_limited` | 429 | Too many requests |

On the MCP transport the error travels as JSON-RPC with `code: -32402`, the same HTTP status as above, and the details in `error.data.l402`.

---

## 9. Security model

### What the protocol guarantees

- A provider cannot collect more than the latest amount the payer signed.
- A payer cannot spend the same voucher twice: monotonicity is enforced by the contract.
- A third party that intercepts a voucher cannot use it: only the channel's provider can settle it.
- A voucher is bound to chain and escrow: no cross-chain replay.
- A compromised session key costs at most its `maxCumulative` per channel.
- A payer cannot make vouchers it already handed out unsettleable faster than `CLOSE_CHALLENGE_PERIOD` (close request, key revocation, key tightening) — except by letting the channel reach its natural `expiry`, which the server watches.

### What is left to the implementation

- **Store atomicity.** `advance()` must be atomic per channel, otherwise concurrent requests bypass payment. Implemented with an in-memory lock and a Lua script on Redis. `markSettled()` is atomic on Redis as well.
- **Freshness of the on-chain cache.** The gatekeeper caches channel state (default 15 s) to stay under 10 ms. Every payer action that hurts the provider is delayed by 24 hours, which dwarfs the TTL.
- **Settler availability.** The server only accepts vouchers with at least `minVoucherTimeLeft` / `minChannelTimeLeft` left; the settler must run more often than `expiryBuffer` to collect them in time.
- **ERC-1271.** A smart account can change what `isValidSignature` accepts after signing; its vouchers should be settled sooner.
- **Key custody.** `MACAROON_ROOT_KEY` and `PROVIDER_PRIVATE_KEY` belong in a secret manager. Rotating the root key invalidates every macaroon in circulation.

---

## 10. Contract parameters

| Parameter | Value | Notes |
|---|---|---|
| `CLOSE_CHALLENGE_PERIOD` | 24 hours | Wait for a unilateral close; also the delay of session key revocations |
| `MIN_CHANNEL_DURATION` | 1 hour | Minimum lifetime |
| `MAX_CHANNEL_DURATION` | 365 days | Maximum lifetime |
| `MAX_PROTOCOL_FEE_BPS` | 500 (5%) | Cap on the protocol fee |

---

## 11. Token notes

| Token | Decimals | `permit` | ERC-3009 | Deposit |
|---|---|---|---|---|
| cbBTC (Base) | 8 | yes | yes | one signature |
| WBTC (Arbitrum, Optimism) | 8 | no | no | `approve` + `openChannel`, ideally batched with ERC-4337 |
| tBTC | 18 | yes | no | `permit` + `openChannel` |

With an ERC-4337 smart account the lack of `permit` is not a problem: `approve` and `openChannel` end up in the same atomic UserOperation.
