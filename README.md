# L402-EL2 — L402 on Ethereum Layer 2

An adaptation of the **L402** protocol (born on the Lightning Network) to **Ethereum Layer 2**, so that AI agents can pay for the tools of **MCP servers** in **wrapped BTC** (cbBTC, WBTC, tBTC).

The problem it solves: an agent that calls an MCP tool a thousand times a day cannot send a thousand on-chain transactions — it would pay more in gas than for the service and wait ~2 seconds per call. Here payments travel **off-chain** as EIP-712 signatures on a prefunded channel, and the blockchain is touched only twice: when the channel is opened and when the provider collects.

```
┌──────────────┐                                        ┌───────────────┐
│  AI Agent    │                                        │  MCP server   │
│ (ERC-4337)   │                                        │  (provider)   │
└──────┬───────┘                                        └───────┬───────┘
       │  1. openChannel(0.001 cbBTC)   ── 1 L2 tx ──────────►  │
       │                                                        │
       │  2. tools/call ────────────────────────────────────►   │
       │  ◄─────────────── 402 + macaroon + payment request ──  │
       │  3. EIP-712 signature (local, 0 gas, <1ms)             │
       │  4. tools/call + Authorization: L402 mac:voucher ──►   │  verified in ~5ms
       │  ◄──────────────────────────── 200 + result ─────────  │
       │                                                        │
       │       ... thousands of calls, 0 transactions ...       │
       │                                                        │
       │                          5. settleBatch() ── 1 L2 tx ─►│
└──────────────┘                                        └───────────────┘
```

> 📖 For an in-depth walkthrough of how every piece works, see [`docs/guidaeng.md`](docs/guidaeng.md) (English) or [`docs/GUIDA.md`](docs/GUIDA.md) (Italian). The wire protocol is specified in [`docs/SPEC.md`](docs/SPEC.md).

## What's inside

| Package | Content |
|---|---|
| `packages/contracts` | `L402Escrow.sol` — unidirectional payment channel with cumulative EIP-712 vouchers, on-chain session keys, batch settlement |
| `packages/core` | Macaroons, EIP-712 types and digests, L402 header encoding, ABI, unit conversions |
| `packages/server` | Gatekeeper (verification), HTTP and MCP middlewares, voucher store (memory/Redis) |
| `packages/client` | Agent wallet (EOA / ERC-4337 / session key), self-paying `fetch` interceptor, MCP client |
| `packages/settler` | Service that turns accumulated vouchers into L2 transactions |
| `examples` | Server, agent and an end-to-end run on an in-process EVM |

## Try it now

No chain, no account, no configuration needed:

```bash
npm install
npm run compile:contracts
npm run example:e2e
```

You will see the contracts deployed on an in-process EVM, a paid MCP server start, an agent open a channel with a session key, pay four calls off-chain, and finally everything collected in a single transaction.

## Tests

```bash
npm run test:contracts   # 21 escrow tests on a real EVM (in-process EDR)
npx vitest run           # 81 tests: core, gatekeeper (incl. attack scenarios), stores, MCP, client, settler
npm run example:e2e      # full integration
```

The 6 Redis store tests run only when a Redis server is reachable:

```bash
REDIS_URL=redis://127.0.0.1:6379 npx vitest run
```

With Foundry installed, the Solidity suite (18 tests, including a fuzz test) runs too. `remappings.txt` expects `forge-std` in `node_modules`:

```bash
npm i --no-save forge-std@github:foundry-rs/forge-std
cd packages/contracts && forge test -vvv
```

## How payment works

### The voucher is cumulative

Each signature authorizes the provider to collect **a total** on the channel, not a delta:

```
voucher #1:  cumulativeAmount = 250     "you may take up to 250"
voucher #2:  cumulativeAmount = 500     "you may take up to 500"
voucher #3:  cumulativeAmount = 750     "you may take up to 750"
```

The provider only keeps the latest one: presenting #3 collects 750 in one go. Three useful properties follow:

- **no replay**: the contract only accepts strictly increasing amounts, so an old voucher is automatically inert;
- **the server is stateless-friendly**: one Redis row per channel is enough;
- **losses are bounded**: the most a dishonest provider can take is the latest amount the agent actually signed.

The signed structure:

```solidity
Voucher(bytes32 channelId, uint256 cumulativeAmount, uint64 nonce, uint64 validUntil)
```

`channelId` is `keccak256(abi.encode(payer, provider, token))`: the client computes it offline, without a single RPC call.

The cumulative counter of a channel starts at `claimed + refunded` (exposed as `cumulativeFloor(channelId)`). Refunds raise it too, so **every voucher signed before a withdrawal dies with it**, even if the same channel is later reopened.

### The headers

**Challenge (402):**

```
WWW-Authenticate: L402 macaroon="<b64url>", invoice="<b64url>", payment_request="<b64url>", version="1"
```

`invoice` is kept for compatibility with existing L402 parsers; its content is an EVM payment request instead of a Lightning invoice:

```json
{
  "scheme": "l402-el2", "version": 1,
  "chainId": 8453,
  "escrow": "0x…", "token": "0x…", "tokenSymbol": "cbBTC", "tokenDecimals": 8,
  "provider": "0x…",
  "amount": "250",
  "cumulativeAmount": "1750",
  "channelId": "0x…",
  "validUntil": 1786717539
}
```

**Credentials:**

```
Authorization: L402 <macaroon_b64url>:<proof_b64url>
X-L402-Payer: 0x…
```

The field after the colon — the Lightning preimage in the original L402 — is the signed voucher here. It is **the** design choice of the protocol: the proof of payment is a signature verifiable in memory in milliseconds, not a transaction hash to look up on-chain.

### Why macaroons and not JWTs

A macaroon can be **attenuated by whoever holds it**, without knowing the server's key. An agent holding a token "valid for every tool up to 0.001 BTC" can derive one "valid only for `search_web`, for the next 60 seconds" and hand it to a sub-agent — and the server verifies it with the same root key, knowing nothing about the delegation.

Caveats are verified **fail-closed**: if a caveat references a key the server cannot evaluate, the request is refused. Standard caveats: `expires_at`, `payer`, `channel_id`, `chain_id`, `token`, `max_cumulative`, `tool`, `service`.

### Session keys: the spending cap is on-chain

"I allow the agent to spend up to 0.0005 cbBTC" is not a rule written in the client — it is a line in the smart contract:

```solidity
escrow.authorizeSigner(sessionKey, maxCumulative, validUntil);
```

The session key signs vouchers instead of the payer, but the contract rejects any voucher whose cumulative amount exceeds the cap (the cap applies to each channel of the payer). If the key leaks, the loss is bounded. The delegation can also be signed off-chain (`authorizeSignerWithSig`) so the human signs and the agent pays the gas; `invalidateDelegationNonce()` cancels signed delegations that were never submitted.

A live delegation can be **widened** at any time but not narrowed: `revokeSigner` (and any tightening) takes effect only after the same 24-hour grace period as a channel close, so a payer cannot consume a service with session-key vouchers and then make them unsettleable.

This works both with ERC-4337 smart accounts and with EOAs, without depending on a specific account-abstraction vendor.

## The cost model

With $0.005 of gas per L2 transaction and 20,000 calls per day:

| | Pure on-chain (1 tx per call) | L402-EL2 (off-chain channel) |
|---|---|---|
| Gas per day | ~$100 | ~$0.05 (openings + settlements) |
| Latency per call | 1–2 s (block wait) | < 10 ms (local signature check) |
| Scalability | bounded by L2 blocks | bounded only by the server's CPU |
| Transactions per month | ~600,000 | ~30 per user |

The settler's `MIN_SETTLE_AMOUNT` makes sure a settlement never loses money: below that amount the pending balance keeps accumulating, above it the transaction goes out — unless a deadline is close, in which case the settler collects anyway.

## Production setup

### 1. Deploy the escrow

```bash
npm run compile:contracts
cd packages/contracts
DEPLOYER_PRIVATE_KEY=0x… CHAIN=base ESCROW_OWNER=0x… node tools/deploy.mjs
```

Or with Foundry:

```bash
forge script script/Deploy.s.sol --rpc-url base --broadcast --verify
```

### 2. MCP server

```bash
cp .env.example .env    # fill in ESCROW_ADDRESS, TOKEN_ADDRESS, PROVIDER_PRIVATE_KEY,
                        # MACAROON_ROOT_KEY (openssl rand -hex 32), REDIS_URL
npm run example:server  # .env is loaded automatically
```

To protect your tools, this is the part that matters:

```ts
const app = createMcpL402App({
  gatekeeper,
  createServer: () => {
    const server = new McpServer({ name: "…", version: "0.1.0" });
    server.registerTool("search_web", { inputSchema: { query: z.string() } }, handler);
    return server;
  },
});
```

`initialize`, `tools/list` and notifications stay **free**: an agent must be able to discover what you offer and what it costs before opening a channel. Only `tools/call`, `resources/read` and `prompts/get` are billed (an allowlist, not a denylist), and a JSON-RPC batch may contain at most one paid call.

### 3. Settler

The settler must share the voucher store with the server (Redis), since it runs as a separate process.

```bash
npm run build                # builds the packages (the CLI runs from dist/)
npx l402-settler plan        # what it would collect, without sending anything
npx l402-settler once        # one settlement and exit
npx l402-settler loop        # keeps running and settles at intervals
```

### 4. Agent

```ts
const client = await connectPaidMcpClient({
  url: "https://mcp.example.com/mcp",
  channels,
  policy: {
    maxPricePerCall: parseUnits("0.0001", 8),
    totalBudget: parseUnits("0.0005", 8),
    allowedProviders: [provider],
    allowedEscrows: [escrow],
  },
});

// From here on the agent calls tools as if they were free.
await client.callTool({ name: "search_web", arguments: { query: "…" } });
```

## Security choices

- **Macaroons are bound by the server.** A macaroon is only accepted if the server itself bound it to the payer's channel when minting it (the channel id is part of the HMAC root): a holder cannot bind an unbound macaroon by appending a `payer` caveat.
- **Only settleable signatures.** ERC-6492 signatures (smart accounts not deployed yet) are refused: viem can verify them off-chain, but the escrow cannot.
- **No RPC on unauthenticated paths.** Challenges never read the chain, and the on-chain cache is bounded, so random `X-L402-Payer` headers cannot turn the server into an RPC amplifier.
- **Restart-safe clients.** Each challenge carries the last voucher the server accepted; a client that lost its state verifies it (signed by the payer or by a key the payer delegated) and resumes, instead of refusing every payment.
- **Atomic voucher verification.** `store.advance()` is atomic per channel (in-memory lock, Lua script on Redis). Without it a client could fire N parallel requests with the same voucher and pay for one.
- **Only settleable vouchers are accepted.** The server refuses vouchers that expire in less than `minVoucherTimeLeft` (2h), channels that close (expiry or pending close request) in less than `minChannelTimeLeft` (2h), and session keys that expire or were revoked within the same window. The settler treats all these deadlines as urgent.
- **Challenge period.** A payer who closes the channel must wait 24 hours: enough time for the provider to settle the latest voucher. A `topUp` cancels a pending close.
- **Revocations honour the same grace period.** Revoking or narrowing a session key takes effect after 24 hours.
- **Pausing does not freeze funds.** `pause()` only blocks new deposits. Settlements and withdrawals are always possible: the contract owner cannot seize other people's money.
- **The cumulative counter never goes back.** `claimed` and `refunded` are never reset, and refunds consume the counter too: old vouchers stay useless after a close and reopen.
- **Non-hijackable ERC-3009.** The authorization nonce is bound to the channel parameters (`computeAuthNonce`): whoever intercepts the signature in the mempool cannot use it to open a channel towards a different provider.
- **ERC-1271.** Vouchers of ERC-4337 smart accounts are verified through `SignatureChecker`, both on-chain and server-side.
- **Two lines of defence on spending.** The client's `SpendingPolicy` avoids signing (it checks the real increment against the budget, and refuses challenges for another chain/escrow/token before any auto top-up); the session key cap in the contract avoids paying. The first can be bypassed by compromising the agent process, the second cannot.

### What is missing before mainnet

- **Audit.** The contract is tested but has not been audited. Do not put real funds on it without an external review.
- **ERC-1271 signatures are revocable.** A smart account can change its signature logic after signing; the contract checks the signature at settlement time. Providers serving smart accounts should settle more often.
- **Third-party caveats.** Macaroons implement first-party caveats only. Delegations to third-party services would need the third-party caveats of the original macaroon standard.
- **`type: "tx"` fallback.** The proof type is defined in the schemas but not implemented: the protocol currently only accepts channel vouchers.
- **Rate limiting.** The gatekeeper already defines the `rate_limited` code, but the logic must be added according to your traffic.
- **MCP session cleanup.** Sessions are dropped when the client closes them; idle sessions are kept in memory.

## Layout

```
packages/
  contracts/   L402Escrow.sol, mocks, tests (node + Foundry), deploy
  core/        macaroons, EIP-712, L402 headers, ABI, units
  server/      Gatekeeper, HTTP/MCP middlewares, voucher stores
  client/      wallet, channel, L402 fetch, MCP client, ERC-4337
  settler/     batch settlement + CLI
examples/      server.ts, agent.ts, e2e.ts
docs/          SPEC.md (protocol), guidaeng.md / GUIDA.md (in-depth guide, English / Italian)
```

## Standards used

| Standard | Role |
|---|---|
| **L402** | HTTP 402 scheme + macaroons |
| **EIP-712** | vouchers and delegations signed off-chain |
| **ERC-4337** | agent smart account, atomic batching |
| **ERC-1271** | smart account signature verification |
| **ERC-2612 / ERC-3009** | single-signature deposits for tokens that support them |
| **MCP** | protocol of the tools exposed to the agent |

MIT license.
