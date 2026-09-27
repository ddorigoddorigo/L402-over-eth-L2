# L402-EL2 — Guida approfondita

Questa guida spiega come funziona il software, dal contratto Solidity fino all'agente AI che paga da solo. È pensata per chi deve mantenere il codice, estenderlo o metterlo in produzione. Il codice e i commenti sono in inglese; qui i nomi di funzioni, tipi e file sono riportati esattamente come compaiono nel codice. La stessa guida in inglese è in [`guidaeng.md`](guidaeng.md).

Indice:

1. [Il problema e l'idea](#1-il-problema-e-lidea)
2. [I concetti di base](#2-i-concetti-di-base)
3. [Architettura del monorepo](#3-architettura-del-monorepo)
4. [Il contratto `L402Escrow`](#4-il-contratto-l402escrow)
5. [`core`: le primitive condivise](#5-core-le-primitive-condivise)
6. [`server`: il Gatekeeper e i middleware](#6-server-il-gatekeeper-e-i-middleware)
7. [`client`: il portafoglio dell'agente](#7-client-il-portafoglio-dellagente)
8. [`settler`: l'incasso](#8-settler-lincasso)
9. [Una chiamata dall'inizio alla fine](#9-una-chiamata-dallinizio-alla-fine)
10. [Le scadenze e perché sono legate tra loro](#10-le-scadenze-e-perché-sono-legate-tra-loro)
11. [Configurazione e messa in produzione](#11-configurazione-e-messa-in-produzione)
12. [I test](#12-i-test)
13. [Modello di sicurezza e limiti noti](#13-modello-di-sicurezza-e-limiti-noti)
14. [Bug corretti](#14-bug-corretti)
15. [Glossario](#15-glossario)

---

## 1. Il problema e l'idea

Un agente AI che usa i tool di un server MCP (Model Context Protocol) può fare migliaia di chiamate al giorno. Se ognuna fosse una transazione on-chain, anche su un Layer 2 economico, l'agente pagherebbe più gas che servizio e aspetterebbe un blocco (1–2 secondi) a ogni chiamata.

**L402** è uno schema nato su Lightning Network: il server risponde `HTTP 402 Payment Required` con una credenziale (un *macaroon*) e una fattura; il client paga e ripete la richiesta allegando macaroon e prova di pagamento. Su Lightning la prova è la *preimage* della fattura.

**L402-EL2** porta lo stesso schema su un Layer 2 di Ethereum, ma sostituisce la preimage con un **voucher**: una firma EIP-712 su un **canale di pagamento** prefinanziato. Il risultato:

- la blockchain si tocca due volte, per **aprire** il canale e per **incassare**;
- in mezzo, ogni chiamata costa una firma locale (meno di un millisecondo, zero gas) e una verifica sul server (pochi millisecondi);
- il token è BTC "wrappato" su EVM (cbBTC su Base, WBTC su Arbitrum/Optimism, tBTC).

---

## 2. I concetti di base

### 2.1 Il canale di pagamento

Un canale è un deposito del **payer** (l'agente o il suo proprietario) chiuso in un contratto a favore di un **provider** (il server MCP), per un certo **token**. È identificato da:

```
channelId = keccak256(abi.encode(payer, provider, token))
```

Chiunque può calcolare il `channelId` offline: il client non deve interrogare la chain per sapere su quale canale firmare.

Il canale è **unidirezionale**: i soldi vanno solo dal payer al provider. Il payer può riprendersi ciò che non è stato speso, ma solo dopo una finestra che protegge il provider (§4.6).

### 2.2 Il voucher cumulativo

Un voucher non dice "ti pago 250", dice "**in totale** puoi prendere fino a 250". Il successivo dice "in totale fino a 500", e così via.

```
chiamata 1   voucher cumulativo = 250
chiamata 2   voucher cumulativo = 500
chiamata 3   voucher cumulativo = 750   ← il provider tiene solo questo
```

Conseguenze pratiche:

- il provider conserva **un solo voucher per canale**, l'ultimo: incassandolo prende tutto il dovuto in una transazione;
- un vecchio voucher è **inutile**: il contratto accetta solo importi più alti di quanto già incassato;
- il massimo che un provider disonesto può prendere è **il voucher più alto che il payer abbia firmato** — che è esattamente quanto il payer ha accettato di pagare.

Il voucher firmato ha questa forma:

```solidity
Voucher(bytes32 channelId, uint256 cumulativeAmount, uint64 nonce, uint64 validUntil)
```

`nonce` è solo un contatore diagnostico; `validUntil` è la scadenza oltre la quale il voucher non è più incassabile.

### 2.3 Il macaroon

Il macaroon è la credenziale HTTP emessa dal server nella risposta 402. È un token con **caveat** (restrizioni) e una firma HMAC a catena:

```
sig₀ = HMAC(rootKey, identifier)
sig₁ = HMAC(sig₀, "service = mcp.example.com")
sig₂ = HMAC(sig₁, "expires_at <= 1786717539")
...
```

Proprietà importanti:

- **non si può togliere** un caveat senza rompere la firma (servirebbe la `rootKey` del server);
- **si può aggiungere** un caveat senza la `rootKey`: basta fare `HMAC(firmaAttuale, nuovoCaveat)`. Si chiama **attenuazione**. Un agente può passare a un sotto-agente un macaroon ristretto (per esempio "solo il tool `search_web`") e il server lo verifica senza sapere nulla della delega.

Nel protocollo il macaroon lega la richiesta a un payer, un canale, una chain, un token, una scadenza e un tetto di spesa.

### 2.4 La session key

Un agente non dovrebbe avere la chiave principale del proprietario. Il contratto permette al payer di **delegare** una chiave usa-e-getta:

```solidity
escrow.authorizeSigner(sessionKey, maxCumulative, validUntil);
```

La session key firma i voucher al posto del payer, ma il contratto rifiuta qualsiasi voucher con importo cumulativo sopra `maxCumulative`. Il tetto di spesa è quindi **on-chain**, non una regola del client che un processo compromesso potrebbe ignorare.

### 2.5 ERC-4337, ERC-1271, ERC-2612, ERC-3009

- **ERC-4337** (account abstraction): il payer può essere uno *smart account*. Vantaggio concreto: `approve` + `openChannel` in una sola operazione atomica.
- **ERC-1271**: gli smart account non hanno una chiave propria; il contratto verifica le loro firme chiamando `isValidSignature` sull'account. Il codice usa `SignatureChecker` di OpenZeppelin, che gestisce sia EOA sia smart account.
- **ERC-2612** (`permit`) ed **ERC-3009** (`receiveWithAuthorization`): permettono di depositare con una firma invece che con `approve` + transazione.

---

## 3. Architettura del monorepo

```
packages/
  contracts/   L402Escrow.sol, mock, test (node + Foundry), deploy
  core/        macaroon, EIP-712, header L402, ABI, unità        ← usato da tutti
  server/      Gatekeeper, middleware HTTP/MCP, store dei voucher
  client/      wallet, ChannelManager, fetch L402, client MCP, ERC-4337
  settler/     incasso batch + CLI
examples/      server.ts, agent.ts, e2e.ts
docs/          SPEC.md (protocollo), GUIDA.md (questa guida), guidaeng.md (la stessa in inglese)
```

Le dipendenze tra pacchetti:

```
            ┌──────────┐
            │   core   │  macaroon, header, EIP-712, ABI
            └────┬─────┘
       ┌─────────┼──────────┐
       ▼         ▼          ▼
  ┌────────┐ ┌────────┐ ┌────────┐
  │ server │ │ client │ │settler │──► usa anche server (tipi e store)
  └────────┘ └────────┘ └────────┘
       │                     │
       └──── Redis ──────────┘   stesso store dei voucher
```

Il contratto (`contracts`) è indipendente: gli altri pacchetti ne usano solo l'ABI, che vive in `core/src/abi.ts` (un test verifica che coincida con quella compilata).

Chi fa cosa, a regime:

| Attore | Processo | Tocca la chain? |
|---|---|---|
| Agente | `client` dentro il processo dell'agente | Solo per aprire/ricaricare il canale e registrare la session key |
| Server MCP | `server` (Express + SDK MCP) | Solo letture, con cache |
| Settler | `settler` (processo separato, CLI) | Sì: invia `settleBatch` |
| Contratto | `L402Escrow` sull'L2 | — |

---

## 4. Il contratto `L402Escrow`

File: `packages/contracts/src/L402Escrow.sol`.

### 4.1 Lo stato di un canale

```solidity
struct Channel {
    address payer;
    address provider;
    address token;
    uint256 deposited;        // totale depositato da sempre
    uint256 claimed;          // totale incassato dal provider da sempre
    uint256 refunded;         // totale restituito al payer da sempre
    uint64  expiry;           // dopo questa data il payer può ritirare subito
    uint64  closeRequestedAt; // ≠ 0 se il payer ha chiesto la chiusura
    bool    exists;
}
```

Tre numeri contano davvero:

```
available        = deposited − claimed − refunded     fondi ancora spendibili
cumulativeFloor  = claimed + refunded                 dove si trova il contatore cumulativo
```

`claimed` e `refunded` **crescono soltanto**, non vengono mai azzerati.

### 4.2 Il contatore cumulativo e il "floor"

Il cuore del contratto è la funzione interna `_settle`:

```solidity
uint256 floor = ch.claimed + ch.refunded;
if (voucher.cumulativeAmount <= floor) revert VoucherNotMonotonic();
...
uint256 delta = voucher.cumulativeAmount - floor;
if (delta > ch.deposited - floor) revert InsufficientChannelBalance();
ch.claimed += delta;
```

Un esempio con numeri:

```
deposito 1000                         floor = 0
voucher 300 incassato → paga 300      claimed = 300, floor = 300
voucher 450 incassato → paga 150      claimed = 450, floor = 450
il payer ritira il resto (550)        refunded = 550, floor = 1000
il payer riapre con altri 1000        deposited = 2000, floor = 1000
un vecchio voucher da 700 → rifiutato (700 ≤ 1000)
un nuovo voucher da 1200 → paga 200
```

Perché il floor include `refunded`: se contasse solo `claimed`, un voucher firmato prima del ritiro e mai incassato potrebbe essere incassato dopo, **con i soldi del nuovo deposito**. Con il floor che include i rimborsi, un ritiro "chiude i conti": tutti i voucher firmati prima diventano carta straccia. Il client ne tiene conto leggendo `cumulativeFloor` (via `ChannelManager.syncCumulative`) e firmando da lì in su.

### 4.3 Apertura e ricarica

- `openChannel(provider, token, amount, duration)`: preleva i token con `transferFrom` (serve un `approve` prima, oppure un batch ERC-4337). Se il canale esiste già, lo ricarica ed eventualmente allunga la scadenza.
- `openChannelWithPermit(...)`: come sopra, ma prima esegue `permit` (ERC-2612). Il `permit` è in un `try`: se qualcuno l'ha già consumato (front-running innocuo), il deposito procede comunque.
- `openChannelWithAuthorization(...)`: usa `receiveWithAuthorization` (ERC-3009). Può inviarla un relayer al posto del payer. Il nonce ERC-3009 deve essere `computeAuthNonce(payer, provider, token, amount, duration, validBefore)`: così chi intercetta la firma non può usarla per aprire un canale verso un altro provider.
- `topUp(channelId, amount, newExpiry)`: ricarica ed eventualmente estende la scadenza.

La durata deve stare tra `MIN_CHANNEL_DURATION` (1 ora) e `MAX_CHANNEL_DURATION` (365 giorni). Qualsiasi nuovo deposito **annulla una chiusura in corso** (`_cancelPendingClose`): se il payer rimette soldi, vuole continuare a usare il canale.

### 4.4 L'incasso

- `settle(voucher, signature, signer)`: il provider incassa un voucher. `signer = address(0)` significa "firmato dal payer".
- `settleBatch(vouchers[], signatures[], signers[])`: N canali in una transazione. È **tutto o niente**: un solo voucher non valido fa fallire l'intero batch (il settler gestisce questo caso, §8).
- `settleAndClose(...)`: chiusura cooperativa. Il provider incassa l'ultimo voucher e restituisce subito il resto al payer.

Solo il provider del canale può incassare (`_providerChannel` controlla `msg.sender`).

Controlli di `_settle`, in ordine:

1. voucher non scaduto (`validUntil >= block.timestamp`);
2. importo sopra il floor;
3. se firmato da una session key: delega attiva, non scaduta, importo entro il tetto;
4. firma valida (ECDSA o ERC-1271) sul digest EIP-712;
5. il delta è coperto dal deposito.

Se è configurata una **fee di protocollo** (`protocolFeeBps`, massimo 5%), viene trattenuta sul delta e inviata a `feeRecipient`.

### 4.5 Le deleghe (session key)

```solidity
struct Delegation { uint256 maxCumulative; uint64 validUntil; bool active; }
mapping(address payer => mapping(address signer => Delegation)) public delegations;
```

- `authorizeSigner(signer, maxCumulative, validUntil)`: chiamata diretta del payer.
- `authorizeSignerWithSig(payer, signer, maxCumulative, validUntil, nonce, signature)`: il payer firma off-chain, chiunque invia la transazione. Il `nonce` deve essere `delegationNonces[payer]` e viene incrementato.
- `invalidateDelegationNonce()`: incrementa il nonce, annullando le deleghe firmate ma non ancora inviate.
- `revokeSigner(signer)`: revoca la chiave.

**Regola chiave**: una delega "viva" (attiva e non scaduta) si può **allargare** subito (tetto più alto, scadenza più lontana) ma **non restringere** subito. La revoca (e l'anticipo della scadenza) ha effetto solo dopo `CLOSE_CHALLENGE_PERIOD` (24 ore):

```solidity
function _earliestAllowedDeadline(uint64 current) internal view returns (uint64) {
    uint64 graceEnd = uint64(block.timestamp) + CLOSE_CHALLENGE_PERIOD;
    return current < graceEnd ? current : graceEnd;
}
```

Il motivo: senza questo ritardo un payer potrebbe usare il servizio pagando con voucher firmati dalla session key e poi revocare la chiave un istante dopo, rendendo quei voucher non più incassabili. Il provider avrebbe lavorato gratis.

Attenzione a una sottigliezza: il tetto si confronta con l'**importo cumulativo del canale**, non con "quanto ha firmato questa chiave". Quindi:

- vale separatamente **per ogni canale** del payer;
- dopo un rimborso il floor sale, e con esso gli importi cumulativi: può servire alzare il tetto.

### 4.6 Chiusura e ritiro

- `requestClose(channelId)`: il payer avvia la chiusura unilaterale.
- `withdraw(channelId)`: il payer ritira `available` se **(a)** il canale è scaduto (`expiry <= now`), oppure **(b)** sono passate 24 ore da `requestClose`.

```
requestClose ──────── 24 ore ────────► withdraw possibile
      │                                      │
      └── il provider può ancora incassare ──┘
```

Dopo il ritiro, `refunded` sale e con lui il floor (§4.2), e `expiry` viene portato a "adesso".

Attenzione: alla **scadenza naturale** il payer può ritirare **senza attesa**. Il provider deve quindi incassare prima di `expiry`. Il server rifiuta voucher su canali che scadono entro `minChannelTimeLeft` e il settler considera la scadenza del canale una data limite (§10).

### 4.7 Amministrazione e pausa

- `setProtocolFee(bps, recipient)`: solo l'owner, massimo 500 bps.
- `pause()` / `unpause()`: la pausa blocca **solo i nuovi depositi**. Incassi e ritiri restano sempre possibili: l'owner non può congelare i fondi degli utenti.
- L'ownership è `Ownable2Step` (il passaggio di proprietà richiede l'accettazione del nuovo owner).

### 4.8 Eventi utili per un indicizzatore

`ChannelOpened`, `ChannelToppedUp`, `VoucherSettled` (con `delta` e `fee`), `CloseRequested`, `CloseCancelled`, `ChannelWithdrawn`, `SignerAuthorized`, `SignerRevoked` (con `effectiveAt`), `DelegationNonceInvalidated`, `ProtocolFeeUpdated`.

---

## 5. `core`: le primitive condivise

Cartella: `packages/core/src/`.

| File | Contenuto |
|---|---|
| `types.ts` | Tipi del protocollo (`Voucher`, `PaymentRequest`, `Macaroon`, `PaymentProof`, codici d'errore), operatori dei caveat, `CLOSE_CHALLENGE_PERIOD` |
| `eip712.ts` | Dominio EIP-712, `computeChannelId`, `voucherTypedData`, `delegationTypedData`, digest |
| `macaroon.ts` | Conio, attenuazione, codifica, verifica della firma e dei caveat |
| `header.ts` | Costruzione e parsing degli header `WWW-Authenticate` e `Authorization`, validazione delle proof |
| `abi.ts` | ABI minima di `L402Escrow` ed ERC-20 |
| `networks.ts` | Indirizzi dei wrapped BTC per chain |
| `units.ts` | `parseUnits` / `formatUnits` senza float |

### 5.1 Macaroon in pratica

```ts
const m = mintMacaroon({
  rootKey,
  service: "mcp.example.com",
  caveats: [caveat(CaveatKeys.expiresAt, "<=", now + 3600)],
});

// il client, senza rootKey, restringe il macaroon a un tool
const narrow = attenuate(m, [caveat(CaveatKeys.tool, "=", "search_web")]);

// il server verifica firma + caveat contro un "contesto"
verifyMacaroon(rootKey, narrow, { expires_at: now, tool: "search_web" }); // { ok: true }
```

Regole di valutazione dei caveat (`compare` in `macaroon.ts`):

- se entrambi i valori sono interi, il confronto è numerico con `bigint` (niente errori lessicografici su numeri grandi);
- altrimenti `=` e `!=` confrontano stringhe senza distinguere maiuscole/minuscole, mentre `<`, `>` ecc. **falliscono**;
- `in` controlla l'appartenenza a una lista separata da virgole;
- **fail-closed**: se il caveat usa una chiave che il contesto non contiene, la verifica fallisce.

Il formato di un caveat è **canonico**: `chiave operatore valore` con esattamente uno spazio prima e dopo l'operatore. La chiave non può contenere spazi; il valore è tutto ciò che segue, carattere per carattere. Così un caveat aggiunto con `attenuate` sopravvive identico alla codifica e alla decodifica, e la firma resta valida.

`macaroonExpiry(m)` legge la scadenza dai caveat `expires_at`: il client la usa per sapere quando smettere di riutilizzare un macaroon.

### 5.2 Gli header

Challenge (risposta 402):

```
WWW-Authenticate: L402 macaroon="<b64url>", invoice="<b64url>", payment_request="<b64url>", version="1"
```

Credenziali:

```
Authorization: L402 <macaroon_b64url>:<proof_b64url>
```

`decodeProof` valida **ogni campo** della proof (formato del `channelId`, importo come stringa decimale, `nonce` e `validUntil` interi non negativi, firma esadecimale, `signer` indirizzo). Un input malformato genera un `MacaroonError` con codice `malformed_credentials`, che il server trasforma in una risposta 401 pulita.

### 5.3 Unità

Gli importi sono sempre in **unità base** (satoshi per cbBTC/WBTC, 8 decimali). Mai float:

```ts
parseUnits("0.00001", 8)  // 1000n
formatUnits(1000n, 8)     // "0.00001"
parseUnits("0.000000001", 8) // errore: troppi decimali, non tronca in silenzio
```

---

## 6. `server`: il Gatekeeper e i middleware

Cartella: `packages/server/src/`.

### 6.1 Configurazione (`config.ts`)

```ts
const gatekeeper = new Gatekeeper({
  service: "mcp.example.com",
  rootKey,                 // ≥ 32 byte
  provider,                // indirizzo che incassa
  chainId, escrow, token, tokenSymbol, tokenDecimals,
  publicClient,            // client viem in sola lettura
  store,                   // MemoryVoucherStore o RedisVoucherStore
  pricing: { default: 100n, resources: { search_web: 250n } },
});
```

Parametri opzionali e default:

| Parametro | Default | Significato |
|---|---|---|
| `macaroonTtl` | 3600 s | Durata del macaroon emesso |
| `voucherTtl` | 86400 s | Scadenza suggerita per i voucher (`validUntil` nella payment request) |
| `minVoucherTimeLeft` | 7200 s | Vita residua minima di un voucher per accettarlo |
| `minChannelTimeLeft` | 7200 s | Vita residua minima di canale e session key |
| `macaroonMaxCumulative` | 1000 × prezzo più alto | Quanto può "spendere" un singolo macaroon oltre l'importo attuale |
| `minDeposit` | 1000 × prezzo più alto | Deposito suggerito al client |
| `chainCacheTtlMs` | 15000 ms | Durata della cache delle letture on-chain |

`resolveConfig` rifiuta configurazioni incoerenti (per esempio `voucherTtl <= minVoucherTimeLeft`, che farebbe rifiutare al server i voucher che lui stesso chiede).

### 6.2 La challenge

`gatekeeper.challenge({ resource, payer })` costruisce il 402:

1. calcola il prezzo della risorsa;
2. conia un macaroon con i caveat `service`, `chain_id`, `token`, `expires_at`;
3. se conosce il payer (header `X-L402-Payer`), aggiunge `payer`, `channel_id` e `max_cumulative`, e mette nella payment request l'**importo cumulativo esatto** da firmare: `max(ultimo accettato, floor on-chain) + prezzo`.

Con quell'importo il client deve solo firmare, senza nessuna chiamata RPC.

Due dettagli importanti:

- la challenge **non legge mai la chain**. Chiunque può chiederne una con un `X-L402-Payer` qualsiasi: se ogni richiesta facesse una lettura RPC, il server diventerebbe un amplificatore di traffico verso il nodo. Il "floor on-chain" usato qui è solo quello già in cache; se è troppo basso, la verifica successiva legge la chain e la challenge che rimanda è esatta;
- se lo store ha già un voucher accettato per quel canale, la payment request lo include nel campo `lastVoucher`: serve al client che ha perso il proprio stato (per esempio dopo un riavvio) per riallinearsi (§7.2).

### 6.3 L'autorizzazione, passo per passo

`gatekeeper.authorize({ authorization, resource, payerHint })` esegue i controlli dal più economico al più costoso:

```
 1. header presente e ben formato ............... missing_credentials / malformed_credentials
    proof di tipo "voucher" ...................... invalid_proof
 2. legato dal server a un payer ................. invalid_macaroon
    firma HMAC + tutti i caveat .................. invalid_macaroon / caveat_failed
    macaroon non revocato ........................ revoked
 3. voucher sul canale giusto .................... invalid_proof
    validUntil ≥ now + minVoucherTimeLeft ........ voucher_expired
 4. se c'è una session key: delega attiva, ....... delegation_invalid
    valida ancora per minChannelTimeLeft, entro il tetto
 5. firma non in formato ERC-6492 ................ invalid_signature
    firma EIP-712 valida (EOA o ERC-1271) ........ invalid_signature
 6. canale esistente .............................. channel_not_found
    non chiude entro minChannelTimeLeft ........... channel_closing
    importo ≤ deposited ........................... insufficient_deposit
 7. importo ≥ max(ultimo accettato, floor) + prezzo  insufficient_payment
    avanzamento atomico dello store ............... voucher_not_monotonic
```

Note sui passi:

- **Legato dal server**: il `channelId` nell'identifier del macaroon (che fa parte della radice HMAC e quindi non si può aggiungere dopo) deve coincidere con il canale del caveat `payer`. Un macaroon emesso senza `X-L402-Payer` non ha né payer né tetto di spesa; senza questo controllo chi lo possiede potrebbe "legarlo" da solo aggiungendo un caveat `payer`, saltando il tetto `max_cumulative` del server.
- La **revoca** si controlla dopo la firma HMAC: un macaroon falsificato non arriva mai allo store.
- **ERC-6492** è il formato con cui viem firma per gli smart account non ancora deployati. viem sa verificarlo off-chain, ma il contratto (ERC-1271) no: un voucher così non sarebbe mai incassabile.
- "Non chiude entro" considera sia `expiry` sia, se c'è una richiesta di chiusura, `closeRequestedAt + 24h`.

Se un controllo fallisce, il risultato contiene una **nuova challenge** già pronta: il middleware la rimanda al client, che si riallinea da solo.

Se tutto va bene, il risultato contiene `payer`, `channelId`, `price`, `cumulativeAmount`, `delta` e `remaining` (saldo stimato: `deposited − cumulativeAmount`).

### 6.4 `ChainReader` (`chain.ts`)

Legge `getChannel` e `delegations` dal contratto con una **cache a TTL breve** (15 s) e deduplica le letture concorrenti. La cache ha un **limite di dimensione** (10.000 voci per tipo, eliminando le più vecchie), perché gli id dei canali arrivano dalle richieste e una cache illimitata permetterebbe a chiunque di far crescere la memoria del server. `peekChannel` restituisce l'ultimo stato noto senza nessuna chiamata RPC: è quello che usano le challenge. È un compromesso voluto: la verifica di una chiamata deve restare sotto i ~10 ms. Il rischio (accettare un voucher pochi secondi dopo un cambiamento on-chain) è coperto dal fatto che tutto ciò che il payer può fare contro il provider ha effetto solo dopo 24 ore.

### 6.5 Gli store dei voucher (`store/`)

Interfaccia `VoucherStore`:

| Metodo | Uso |
|---|---|
| `get(channelId)` | Ultimo voucher accettato |
| `advance(voucher, minCumulative)` | Accetta il voucher **solo se** è ≥ `minCumulative` e strettamente maggiore dell'attuale. **Atomico per canale** |
| `listPending(limit)` | Voucher con importo non ancora incassato (per il settler) |
| `markSettled(channelId, amount)` | Registra un incasso on-chain |
| `getSettled(channelId)` | Quanto è già stato incassato |
| `revoke` / `isRevoked` | Revoca dei macaroon |

Perché `advance` deve essere atomico: senza, un client potrebbe mandare 10 richieste in parallelo con lo stesso voucher; tutte leggerebbero lo stesso "ultimo voucher" e passerebbero, e il client pagherebbe una chiamata sola.

- **`MemoryVoucherStore`**: una catena di promise per canale serializza gli `advance`. Va bene per sviluppo e test; si perde tutto al riavvio e il settler (processo separato) non lo vede.
- **`RedisVoucherStore`**: `advance` e `markSettled` sono **script Lua**, eseguiti atomicamente da Redis. Gli importi sono uint256 e Lua usa double a 64 bit, quindi gli script confrontano stringhe di cifre con zeri a sinistra fino a 78 caratteri (a parità di lunghezza, ordine alfabetico = ordine numerico).

Chiavi Redis (con prefisso configurabile, default `l402`):

```
l402:voucher:<channelId>   ultimo voucher (JSON con campo "padded")
l402:settled:<channelId>   importo incassato (stringa con zeri)
l402:pending               set dei canali con qualcosa da incassare
l402:revoked:<tokenId>     macaroon revocati (con TTL)
```

### 6.6 Il middleware HTTP (`http.ts`)

```ts
app.use("/api", l402Middleware(gatekeeper, { resourceOf: (req) => req.path }));
```

- risorse a prezzo 0 passano senza pagamento;
- in caso di errore risponde con lo status di `statusFor(code)` (402, 401 o 429), l'header `WWW-Authenticate` e un JSON `{ error, message, payment }`;
- in caso di successo imposta `req.l402` e gli header `X-L402-Channel-Balance` e `X-L402-Next-Cumulative`.

### 6.7 Il server MCP a pagamento (`mcp.ts`)

`createMcpL402App({ gatekeeper, createServer })` crea un'app Express con:

- `POST /mcp` protetto da `mcpL402Middleware`, poi il trasporto Streamable HTTP dell'SDK MCP;
- `GET /mcp` e `DELETE /mcp` per le sessioni esistenti;
- `GET /.well-known/l402` (discovery) e `GET /health`.

Il middleware guarda **dentro** il messaggio JSON-RPC:

- sono a pagamento solo `tools/call`, `resources/read` e `prompts/get` (allowlist); `initialize`, `tools/list`, notifiche e ping sono gratuiti;
- il nome della risorsa è il nome del tool (o l'URI della risorsa);
- un batch JSON-RPC può contenere **al massimo una** chiamata a pagamento, altrimenti risposta 400;
- gli errori viaggiano come JSON-RPC con `code: -32402` e il dettaglio in `error.data.l402`.

Gestione delle sessioni: una nuova sessione nasce solo da una richiesta `initialize`; un `mcp-session-id` sconosciuto riceve 404 (come prevede la specifica MCP) invece di creare un trasporto nuovo. Le richieste con `Content-Type` diverso da `application/json` vengono rifiutate con 415 prima di arrivare al middleware di pagamento, che altrimenti non potrebbe leggerne il contenuto.

---

## 7. `client`: il portafoglio dell'agente

Cartella: `packages/client/src/`.

### 7.1 I wallet (`wallet.ts`, `erc4337.ts`)

Tutti implementano `L402Wallet`:

```ts
interface L402Wallet {
  address: Address;        // il payer, proprietario del canale
  signerAddress: Address;  // chi firma i voucher (diverso con la session key)
  signVoucher(chainId, escrow, voucher): Promise<Hex>;   // locale, zero gas
  sendCalls(calls): Promise<Hex>;                         // transazioni on-chain
}
```

| Funzione | Quando usarla |
|---|---|
| `createEoaWallet` | Chiave privata classica. Più chiamate = più transazioni in sequenza; si ferma alla prima che fallisce |
| `createSmartAccountWallet` | Qualsiasi client ERC-4337 compatibile; le chiamate vanno in una sola UserOperation atomica |
| `createBaseSmartAccountWallet` | Coinbase Smart Wallet pronto all'uso, con bundler e paymaster opzionale |
| `createSessionKeyWallet` | Avvolge un wallet proprietario: firma con una chiave usa-e-getta, `authorize()` e `revoke()` registrano/revocano la delega |

### 7.2 `ChannelManager` (`channel.ts`)

Gestisce il canale verso ogni provider e firma i voucher.

```ts
const channels = new ChannelManager({ wallet, publicClient, chainId, escrow, token });
await channels.open(provider, deposit);         // approve (se serve) + openChannel
const snap = await channels.snapshot(provider); // stato on-chain
```

Il **modello di responsabilità**: il provider può sempre incassare il voucher più alto mai firmato. Per questo `getCumulative(provider)` tiene **il massimo firmato**, e non scende mai.

`signNext(provider, target, options)`:

- calcola l'**incremento** reale: `max(0, target − massimo firmato)`;
- rifiuta se l'incremento supera `maxIncrement` (tentativo di sovrafatturazione);
- chiama `approve(increment)` per l'ultimo controllo (il budget, lato `fetch`);
- **prenota** l'importo in modo sincrono, *prima* di attendere la firma: così due chiamate concorrenti non contano lo stesso incremento due volte;
- se il server chiede un importo ≤ del massimo già firmato, firma senza problemi (incremento 0: non costa niente in più). Succede quando un voucher precedente è stato rifiutato, o con chiamate parallele.

`syncCumulative(provider)` allinea il contatore al `cumulativeFloor` on-chain (utile dopo un riavvio).

`topUp(provider, amount)` ricarica il canale ed esegue prima un `approve` se l'allowance non basta (come fa `open`).

**Ripartire dopo un riavvio** — `adoptServerState(provider, lastVoucher)`. Dopo un riavvio il contatore locale riparte dal floor on-chain, ma il server può avere voucher accettati e non ancora incassati. Senza riallineamento il server chiederebbe un importo molto più alto del prezzo e il client rifiuterebbe ogni pagamento fino al prossimo incasso. Il client quindi "adotta" il `lastVoucher` della payment request, ma **solo se è comunque incassabile on-chain**: canale giusto, non scaduto, firma valida, firmato dal payer, dalla session key attuale o da una chiave che il payer ha delegato on-chain con un tetto sufficiente. Un voucher così è già un debito del payer: riconoscerlo non costa niente, e un server disonesto non può inventarne uno.

### 7.3 `createL402Fetch` (`fetch.ts`)

È un `fetch` che paga da solo:

```ts
const l402Fetch = createL402Fetch({ channels, policy, autoTopUp, onPayment });
const res = await l402Fetch("https://api.example.com/search", { method: "POST", body });
```

Il flusso:

```
richiesta ──► ho già macaroon e prezzo per questa risorsa?
                 │ sì: firmo subito il voucher (pagamento ottimistico, 1 round trip)
                 ▼
            invio ──► 200? fine
                 │ 402/401
                 ▼
            leggo la challenge ──► controlli della policy
                 │                  (prezzo, provider, escrow, chain, stessa rete del wallet)
                 ▼
            errore "servono fondi" e autoTopUp attivo? → ricarico il canale
            errore che una firma non può risolvere? → restituisco la risposta, senza firmare
                 ▼
            c'è un lastVoucher verificabile? → riallineo il contatore
                 ▼
            firmo l'importo chiesto dal server (controllo per chiamata e budget sull'incremento reale)
                 ▼
            reinvio (fino a 3 tentativi) ──► 200: salvo macaroon e prezzo in cache
```

La `SpendingPolicy`:

| Campo | Effetto |
|---|---|
| `maxPricePerCall` | Tetto per il prezzo dichiarato e per l'incremento reale di una chiamata |
| `totalBudget` | Tetto della spesa della sessione (calcolata sugli incrementi, non sui prezzi) |
| `allowedProviders` | Paga solo questi provider |
| `allowedEscrows` | Accetta solo questi escrow |
| `allowedChainIds` | Accetta solo queste chain |

Gli errori "che una firma non può risolvere" sono `insufficient_deposit`, `channel_not_found`, `channel_closing` (quando la ricarica automatica non è attiva o è esaurita) e `delegation_invalid`: firmare comunque aumenterebbe il debito e consumerebbe il budget per una chiamata che il server rifiuterebbe di nuovo. I superamenti del limite per chiamata e del budget generano sempre un `PaymentRefused`.

In più, il client rifiuta sempre una challenge che chiede un'altra chain, un altro escrow o un altro token rispetto a quelli del `ChannelManager` (il voucher firmato sarebbe inutilizzabile), e fa tutti questi controlli **prima** di un'eventuale ricarica automatica, così un server malevolo non può far depositare fondi verso un provider non autorizzato.

La cache delle credenziali è per **risorsa**, non solo per URL: su MCP tutte le chiamate vanno a `POST /mcp`, e usare il prezzo di un tool per un altro firmerebbe voucher sbagliati. Il macaroon in cache viene abbandonato 30 secondi prima della scadenza letta dai suoi caveat.

### 7.4 Il client MCP (`mcp.ts`)

```ts
const client = await connectPaidMcpClient({ url, channels, policy });
await client.callTool({ name: "search_web", arguments: { query: "..." } });
```

Inietta `createL402Fetch` nel trasporto Streamable HTTP dell'SDK MCP: l'agente chiama i tool come se fossero gratuiti. `discoverL402Service(url)` legge `/.well-known/l402` per conoscere prezzi e parametri prima di aprire il canale.

---

## 8. `settler`: l'incasso

Cartella: `packages/settler/src/`. È un processo separato che condivide lo store (Redis) con il server.

### 8.1 Il piano (`plan()`)

Esamina **tutti** i voucher in attesa (limite configurabile con `maxScan`). Con una pagina fissa, per esempio i primi 1000, bastano 1000 canali con importi piccoli e non urgenti per non guardare mai gli altri, anche quelli in scadenza.

Per ogni voucher:

1. legge lo stato del canale on-chain (se la lettura fallisce, quel voucher viene saltato con `read_failed` e riprovato al giro dopo, senza fermare il resto);
2. se l'importo è ≤ del floor on-chain, il voucher è già stato incassato (o annullato da un rimborso): lo segna come incassato e lo toglie dall'attesa;
3. calcola la **data limite** di incasso: la più vicina tra scadenza del voucher, scadenza del canale, fine della finestra di una richiesta di chiusura, scadenza della session key;
4. se la data limite è passata, lo salta (`deadline_passed`);
5. è **urgente** se la data limite è entro `expiryBuffer` (default 5400 s);
6. se l'importo è sotto `minSettleAmount` e non è urgente, lo salta (`below_threshold`).

I voucher selezionati sono ordinati per data limite (i più urgenti prima) e tagliati a `batchSize`.

### 8.2 L'esecuzione (`settle()`)

1. simula `settleBatch`;
2. se la simulazione fallisce (un voucher non valido farebbe fallire tutto il batch), simula **ogni voucher da solo** e scarta quelli che fallirebbero, riportandoli in `dropped`;
3. invia la transazione e **controlla lo stato della ricevuta**: se è `reverted`, lancia un errore e non segna niente come incassato;
4. segna i voucher come incassati nello store.

`settleIndividually()` fa lo stesso una transazione per canale (più costoso, ma isola ogni errore).

`startSettlerLoop(settler, intervalMs)` esegue `settle()` a intervalli regolari senza mai sovrapporre due esecuzioni.

### 8.3 La CLI

```bash
npm run build
npx l402-settler plan   # cosa incasserebbe, senza inviare nulla
npx l402-settler once   # un incasso e termina
npx l402-settler loop   # resta acceso (SIGINT/SIGTERM per fermarlo)
```

Legge la configurazione dalle variabili d'ambiente e carica automaticamente il file `.env` della cartella corrente.

---

## 9. Una chiamata dall'inizio alla fine

Questo è ciò che fa `examples/e2e.ts`, con i numeri reali dell'esempio (prezzi: `search_web` 250 sat, `heavy_analysis` 2000 sat).

**Preparazione (on-chain, una volta)**

1. Deploy di `MockBTC` e `L402Escrow`; l'agente riceve 1 cbBTC finto.
2. L'agente crea una session key e la registra: `authorizeSigner(sessionKey, 50_000, now + 1 giorno)`.
3. L'agente apre il canale: `approve` + `openChannel(provider, token, 1_000_000, 30 giorni)`.

**Prima chiamata a `search_web` (off-chain)**

4. Il client invia `initialize` e `tools/list`: gratuiti.
5. Il client invia `tools/call search_web` con `X-L402-Payer: <payer>`, senza `Authorization`.
6. Il server risponde 402. La payment request dice: `amount = 250`, `cumulativeAmount = 250` (floor 0 + 250), `validUntil = now + 24h`.
7. Il client controlla la policy, calcola incremento 250 (≤ 5000 per chiamata, entro il budget), prenota 250, firma il voucher `{channelId, 250, nonce 1, validUntil}` con la session key.
8. Il client ripete la richiesta con `Authorization: L402 <macaroon>:<proof>`.
9. Il server verifica tutto (§6.3), fa `advance` nello store (0 → 250), risponde 200 con il risultato del tool.

**Chiamate successive**

10. Il client ha macaroon e prezzo in cache: firma subito 500, poi 750 (un solo round trip ciascuna).
11. `heavy_analysis` è una risorsa diversa, quindi niente cache: nuovo 402 con `cumulativeAmount = 750 + 2000 = 2750`, firma, 200.

Fin qui: 4 chiamate, 2750 sat, **0 transazioni**.

**Riavvio dell'agente (prima dell'incasso)**

12. L'agente riparte: nuova session key (autorizzata on-chain), nuovo `ChannelManager` con contatore al floor on-chain (0, niente è ancora incassato).
13. Chiama `search_web`. La challenge chiede 2750 + 250 = 3000 e contiene il `lastVoucher` da 2750, firmato dalla vecchia session key.
14. Il client verifica la firma e che la vecchia chiave sia delegata dal payer, adotta 2750 e firma 3000: paga **solo 250**, non 3000.

**Incasso**

15. Il settler trova nello store il voucher da 3000, simula `settleBatch`, invia **una** transazione. Il provider riceve 3000 sat; `claimed = 3000`.
16. Un secondo giro del settler non trova niente da incassare (niente doppio incasso).

Sul canale restano 997.000 sat per le prossime chiamate.

---

## 10. Le scadenze e perché sono legate tra loro

Il provider può incassare un voucher solo finché **tutte** queste condizioni sono vere: il voucher non è scaduto, il canale non è stato svuotato dal payer, la session key (se usata) è ancora valida. La più vicina di queste date è la **data limite**.

```
accettazione del voucher                                     data limite
        │◄──────────── almeno minVoucherTimeLeft/minChannelTimeLeft (2h) ───────────►│
        │                                              │◄──── expiryBuffer (1,5h) ───►│
        │                                              │  il settler lo considera     │
        │                                              │  urgente e lo incassa        │
```

Per non lavorare gratis servono queste relazioni tra i parametri:

| Relazione | Perché |
|---|---|
| `voucherTtl` > `minVoucherTimeLeft` | Altrimenti il server rifiuterebbe i voucher che lui stesso suggerisce (`resolveConfig` lo controlla) |
| `expiryBuffer` > intervallo del settler | Almeno un giro del settler cade dentro la finestra "urgente" |
| `expiryBuffer` < `minVoucherTimeLeft` e `minChannelTimeLeft` | Un voucher appena accettato non è già urgente |
| `CLOSE_CHALLENGE_PERIOD` (24h) ≫ `chainCacheTtlMs` (15 s) | La cache ottimistica del server non espone il provider |

Con i default (voucher 24h, margini 2h, buffer 1,5h, settler ogni ora) ogni voucher accettato viene incassato con almeno 30 minuti di anticipo sulla sua data limite.

---

## 11. Configurazione e messa in produzione

### 11.1 Variabili d'ambiente (`.env.example`)

| Variabile | Usata da | Note |
|---|---|---|
| `CHAIN_ID`, `RPC_URL` | tutti | 8453 Base, 84532 Base Sepolia, 42161 Arbitrum, 10 Optimism |
| `ESCROW_ADDRESS` | tutti | Output del deploy |
| `TOKEN_ADDRESS`, `TOKEN_SYMBOL`, `TOKEN_DECIMALS` | server, settler | cbBTC su Base: `0xcbB7…33Bf`, 8 decimali |
| `SERVICE_NAME`, `PORT` | server | |
| `PROVIDER_PRIVATE_KEY` | server, settler | Il wallet che incassa: in produzione in un KMS/HSM |
| `MACAROON_ROOT_KEY` | server | `openssl rand -hex 32`; ruotarla invalida tutti i macaroon |
| `REDIS_URL`, `REDIS_PREFIX` | server, settler | Obbligatorio in produzione: il settler deve vedere i voucher del server |
| `MIN_SETTLE_AMOUNT`, `SETTLE_BATCH_SIZE`, `SETTLE_INTERVAL_MS`, `SETTLE_EXPIRY_BUFFER` | settler | Vedi §10 |
| `MCP_SERVER_URL`, `AGENT_PRIVATE_KEY`, `BUNDLER_URL`, `DAILY_CAP`, `MAX_PRICE_PER_CALL` | agente | Senza `BUNDLER_URL` l'agente usa una EOA |
| `DEPLOYER_PRIVATE_KEY`, `ESCROW_OWNER`, `FEE_RECIPIENT`, `PROTOCOL_FEE_BPS`, `CHAIN` | deploy | Vuoto o `0x` = valore di default |

Gli esempi e la CLI del settler caricano automaticamente il file `.env` della cartella da cui vengono lanciati.

### 11.2 Sequenza di messa in produzione

1. `npm install && npm run compile:contracts`
2. Deploy dell'escrow: `node packages/contracts/tools/deploy.mjs` (oppure `forge script`).
3. Configura `.env` (escrow, token, chiavi, Redis).
4. Avvia il server MCP (vedi `examples/server.ts` come modello).
5. `npm run build` e avvia `npx l402-settler loop` accanto al server, con lo stesso Redis.
6. Lato agente: `ChannelManager` + `connectPaidMcpClient` con una `SpendingPolicy` restrittiva e una session key con tetto. Il tetto della session key si confronta con il contatore cumulativo del canale: va impostato **sopra il valore attuale del contatore**, come fa `examples/agent.ts` (`channels.getCumulative(provider) + dailyCap`). Un tetto assoluto diventa inutilizzabile appena il canale ha speso quella cifra in totale.

### 11.3 Scegliere i prezzi

I prezzi sono in unità base. Con cbBTC (8 decimali) e BTC a 100.000 $, 1 sat ≈ 0,001 $. `MIN_SETTLE_AMOUNT = 10000` sat ≈ 10 $ assicura che un incasso non costi mai più di quanto incassa (il gas su L2 costa frazioni di centesimo), ma la soglia viene ignorata quando una data limite si avvicina.

---

## 12. I test

| Comando | Cosa copre |
|---|---|
| `npm run test:contracts` | 21 test del contratto su una EVM reale in-process (EDR): apertura, incasso, monotonia, deposito, firme, session key (tetto, revoca con ritardo, niente restringimenti), deleghe firmate off-chain e annullamento del nonce, ERC-1271, batch, chiusura unilaterale, riapertura dopo il ritiro, fee, ERC-3009, pausa |
| `npx vitest run` | 81 test TypeScript: macaroon e header (inclusa la validazione delle proof), coerenza tra ABI TypeScript e contratto compilato, Gatekeeper con scenari d'attacco, store, middleware MCP, client (concorrenza, budget, server malevoli, ripartenza dopo un riavvio), settler |
| `REDIS_URL=redis://… npx vitest run` | In più, 6 test dello store Redis su un Redis vero |
| `forge test` | 18 test Solidity, incluso un fuzz test (serve `forge-std`, vedi README) |
| `npm run example:e2e` | Integrazione completa: contratti, server MCP, agente con session key, pagamenti, riavvio dell'agente, settler |
| `npm run typecheck` | Controllo dei tipi di tutti i pacchetti |

`packages/contracts/tools/evm.mjs` avvia una EVM in-process (lo stesso motore di Hardhat Network) esposta come client viem: è ciò che permette di testare tutto senza installare nodi o Foundry.

---

## 13. Modello di sicurezza e limiti noti

### Cosa è garantito

- Un provider non può incassare più dell'ultimo importo firmato dal payer.
- Un payer non può spendere due volte lo stesso voucher.
- Un terzo che intercetta un voucher non può usarlo: solo il provider del canale incassa.
- Nessun replay tra chain o escrow diversi (dominio EIP-712).
- Una session key compromessa costa al massimo il suo tetto per canale.
- Un payer non può rendere non incassabili voucher già consegnati in meno di 24 ore (chiusura, revoca, restringimento della delega), tranne lasciando arrivare il canale alla sua scadenza naturale, che il server e il settler sorvegliano.
- Richieste concorrenti con lo stesso voucher non passano (store atomico).

### Limiti noti

- **Nessun audit.** Il contratto è testato ma non è stato revisionato da terzi. Non usarlo con fondi reali senza un audit.
- **Le firme ERC-1271 sono revocabili.** Uno smart account può cambiare la propria logica di firma dopo aver firmato; il contratto verifica la firma al momento dell'incasso. Con i payer smart account conviene incassare più spesso.
- **Revoca d'emergenza più lenta.** Il ritardo di 24 ore sulla revoca protegge il provider onesto, ma significa che una session key rubata resta utilizzabile per un giorno (sempre entro il suo tetto, e solo da un provider che la conosca).
- **Tetto della session key per canale.** Si confronta con l'importo cumulativo di ogni canale, non con la spesa totale della chiave.
- **Solo caveat di prima parte.** I caveat di terza parte dello standard macaroon non sono implementati.
- **Proof `type: "tx"`** definita ma non implementata.
- **Rate limiting** da aggiungere secondo il traffico (il codice `rate_limited` esiste già).
- **Sessioni MCP inattive** restano in memoria finché il client non le chiude.

---

## 14. Bug corretti

### Primo giro di revisione

#### Contratto

| # | Problema | Effetto | Correzione |
|---|---|---|---|
| C1 | `revokeSigner` e `authorizeSigner` agivano all'istante | Il payer poteva usare il servizio con voucher della session key e poi revocarla (o abbassarne il tetto/scadenza): il provider non poteva più incassare | Una delega viva si può solo allargare; revoca e anticipo della scadenza hanno effetto dopo `CLOSE_CHALLENGE_PERIOD` |
| C2 | Il floor del contatore era solo `claimed` | Dopo ritiro e riapertura, un vecchio voucher mai incassato poteva essere incassato con i soldi del nuovo deposito (il vecchio test lo verificava come comportamento atteso, contraddicendo la documentazione) | Il floor è `claimed + refunded`; nuova vista `cumulativeFloor` |
| C3 | Una delega firmata off-chain e non inviata non si poteva annullare | Il payer non aveva modo di ritirare una firma data | `invalidateDelegationNonce()` |
| C4 | `Deploy.s.sol` convertiva la fee con `uint16(...)` senza controlli | `PROTOCOL_FEE_BPS=65536` diventava silenziosamente 0 | Controllo del range |

#### Test Foundry

| # | Problema | Correzione |
|---|---|---|
| F1 | 12 test su 16 fallivano anche sul codice originale: `_sign()` fa una chiamata esterna (`voucherDigest`) che consumava `vm.prank` e `vm.expectRevert` | Firma calcolata prima di `vm.prank`; ora 18 test su 18 passano |

#### Server

| # | Problema | Effetto | Correzione |
|---|---|---|---|
| S1 | Accettava voucher già scaduti (tolleranza di 30 s all'indietro) o in scadenza entro pochi secondi | Un client poteva firmare voucher validi 1 secondo e usare il servizio gratis; con il TTL di 300 s e il settler orario, anche un client onesto non veniva mai incassato | `validUntil ≥ now + minVoucherTimeLeft`; TTL suggerito 24 h |
| S2 | Non controllava la scadenza della session key rispetto ai tempi di incasso | Voucher accettati ma non più incassabili | La delega deve valere almeno `minChannelTimeLeft` |
| S3 | Ignorava le richieste di chiusura del canale | Il payer poteva chiedere la chiusura e continuare a usare il servizio, poi ritirare dopo 24 h | "Chiude entro" considera `closeRequestedAt + 24h` |
| S4 | Il minimo richiesto si basava sull'ultimo voucher in store anche se inferiore al floor on-chain | Voucher accettati ma impossibili da incassare (store resettato o non aggiornato) | Minimo = `max(store, floor on-chain) + prezzo`, anche nella challenge |
| S5 | Una proof malformata (es. `cumulativeAmount: "abc"`) generava un'eccezione non gestita | Errore 500 invece di 401 | Validazione completa in `decodeProof` |
| S6 | In un batch MCP si pagava solo la chiamata più cara | N tool al prezzo di uno; e un macaroon limitato a un tool poteva "trascinare" altri tool nel batch | Al massimo una chiamata a pagamento per batch |
| S7 | Ogni POST con id di sessione sconosciuto o senza `initialize` creava un trasporto MCP | Spreco di risorse, comportamento non conforme a MCP | 404 per sessioni sconosciute, 400 senza `initialize` |
| S8 | `RedisVoucherStore.markSettled` era in più passaggi | Un voucher più recente accettato nel mezzo poteva sparire dall'elenco dei pendenti e non essere mai incassato | Script Lua atomico |
| S9 | Il middleware HTTP chiedeva un pagamento anche per risorse a prezzo 0 | Impossibile accedervi (serviva un voucher con incremento > 0) | Le risorse gratuite passano |
| S10 | `macaroonMaxCumulative` e `minDeposit` valevano 0 se il prezzo di default era 0 | Nessun tetto sui macaroon con listini "default gratis, alcuni tool a pagamento" | Default calcolati sul prezzo più alto |

#### Settler

| # | Problema | Effetto | Correzione |
|---|---|---|---|
| T1 | Non controllava lo stato della ricevuta | Una transazione fallita veniva registrata come incasso riuscito | Controllo di `receipt.status` |
| T2 | Un solo voucher non valido faceva fallire la simulazione del batch a ogni giro | Tutti gli incassi bloccati | Fallback: simulazione per singolo voucher, scarto di quelli che falliscono |
| T3 | L'urgenza guardava solo la scadenza del voucher | Canali in scadenza o in chiusura non venivano incassati in tempo | Data limite = minimo tra voucher, canale, chiusura, session key |
| T4 | Giri del loop sovrapposti se un incasso durava più dell'intervallo | Transazioni duplicate | Un giro alla volta |
| T5 | Voucher già incassati on-chain (per altre vie) restavano pendenti e facevano fallire il batch | Blocco degli incassi | Confronto con il floor on-chain |

#### Client

| # | Problema | Effetto | Correzione |
|---|---|---|---|
| L1 | Due chiamate concorrenti con lo stesso importo richiesto facevano lanciare un errore alla seconda | Chiamate MCP parallele fallivano | Prenotazione sincrona; firmare un importo ≤ del massimo è consentito |
| L2 | Il budget si controllava sul prezzo dichiarato, non sull'incremento reale | Un server poteva chiedere un cumulativo più alto del prezzo e superare il budget | Controllo sull'incremento, atomico con la prenotazione |
| L3 | La ricarica automatica avveniva prima dei controlli della policy | Un server malevolo poteva far depositare fondi verso un provider non autorizzato | Controlli prima della ricarica |
| L4 | Non si verificava che la challenge fosse per la stessa chain/escrow/token del wallet | Firme inutilizzabili, controlli della policy aggirabili | Rifiuto esplicito |
| L5 | Il pagamento ottimistico usava una scadenza fissa di 300 s | Con le nuove regole del server sarebbe stato rifiutato | Usa il TTL indicato dal server |
| L6 | Le opzioni `undefined` sovrascrivevano i default del `ChannelManager` | Configurazione silenziosamente errata | Default con `??` |
| L7 | Il wallet EOA non si fermava su una transazione fallita; quello ERC-4337 ignorava le UserOperation fallite | `openChannel` inviato anche se `approve` era fallito | Controllo dell'esito |
| L8 | L'opzione `paymaster` di `createBaseSmartAccountWallet` aveva un tipo senza senso e non veniva usata | Paymaster impossibile da configurare | Passata al bundler client |

#### Tooling ed esempi

| # | Problema | Correzione |
|---|---|---|
| E1 | Gli esempi e la CLI non caricavano mai il file `.env` che il README chiedeva di compilare | `process.loadEnvFile()` |
| E2 | `deploy.mjs` usava `??`: il segnaposto `0x` del `.env.example` veniva passato come indirizzo | Vuoto e `0x` trattati come "non impostato", indirizzi validati |
| E3 | Il README indicava `forge install` ma i remapping puntano a `node_modules` | Istruzioni corrette |
| E4 | Il tipo `Caveat.op` non includeva `!=` e `in`, pur supportati | Tipo unico `CaveatOp` |
| E5 | Un test sulla scadenza del macaroon verificava in realtà un caveat "non prima di" | Test riscritto con `expires_at <=` |

### Secondo giro di revisione

| # | Problema | Effetto | Correzione |
|---|---|---|---|
| R1 | Le challenge (non autenticate) leggevano la chain per ogni `X-L402-Payer`, e la cache delle letture non aveva limite. Il problema era stato introdotto dalla correzione S4 del primo giro | Chiunque poteva far fare al server una chiamata RPC per richiesta e farne crescere la memoria senza limite | Le challenge usano solo lo stato in cache; cache limitata a 10.000 voci |
| R2 | Il server accettava firme ERC-6492 (smart account non ancora deployati) | Voucher accettati ma impossibili da incassare: il contratto verifica con ERC-1271 | Firme ERC-6492 rifiutate |
| R3 | Un macaroon emesso senza payer poteva essere "legato" dal client stesso aggiungendo un caveat `payer` | Si saltava il tetto `max_cumulative` messo dal server | Il `channelId` dell'identifier (firmato dal server) deve coincidere con il payer |
| R4 | La revoca si controllava prima della firma HMAC | Macaroon falsificati arrivavano allo store | Revoca controllata dopo la firma |
| R5 | Dopo un riavvio dell'agente con voucher non ancora incassati, ogni pagamento veniva rifiutato ("incremento troppo alto" o "budget esaurito") fino al successivo incasso del provider | Agente bloccato; verificato con l'e2e sul codice precedente | Campo `lastVoucher` nella payment request e adozione verificata lato client |
| R6 | Con errori che una firma non può risolvere (deposito insufficiente senza ricarica, session key non valida) il client firmava fino a 3 voucher | Debito e budget consumati per chiamate comunque rifiutate | Il client restituisce subito la risposta |
| R7 | Il superamento del limite per chiamata dava un `Error` generico, non un `PaymentRefused` | L'agente non poteva distinguerlo dagli altri rifiuti della policy | `PaymentRefused` sempre |
| R8 | Il parsing dei caveat accettava spazi multipli e li "normalizzava" | Un caveat con spazi iniziali nel valore, aggiunto con `attenuate`, invalidava il macaroon dopo la decodifica | Formato canonico con un solo spazio; chiavi senza spazi |
| R9 | `ChannelManager.topUp` non faceva mai `approve` | La ricarica falliva se l'allowance non bastava | `approve` quando serve, come in `open` |
| R10 | Il settler esaminava solo i primi 1000 voucher in attesa | 1000 canali piccoli e non urgenti bloccavano per sempre l'esame degli altri, anche di quelli in scadenza | Esamina tutti i voucher (`maxScan` configurabile) |
| R11 | Un errore RPC su un solo canale faceva fallire l'intero giro del settler | Nessun incasso finché la lettura non tornava a funzionare | Il voucher viene saltato (`read_failed`) e riprovato al giro dopo |
| R12 | `examples/agent.ts` autorizzava la session key con un tetto assoluto (`DAILY_CAP`) | Appena il canale aveva speso `DAILY_CAP` in totale, ogni nuova esecuzione dell'agente non poteva più pagare | Tetto = contatore attuale del canale + `DAILY_CAP` |
| R13 | Il server MCP si affidava all'SDK per rifiutare i corpi non JSON, che il middleware di pagamento non sa leggere | Nessun aggiramento trovato (l'SDK risponde 415), ma la protezione dipendeva da un dettaglio interno | 415 esplicito prima del middleware |

Controllato e non modificato: lo script `Deploy.s.sol` con il segnaposto `0x` di `.env.example` funziona già (Foundry usa il valore di default quando non riesce a leggere l'indirizzo).

---

## 15. Glossario

| Termine | Significato |
|---|---|
| **402 Payment Required** | Status HTTP con cui il server chiede un pagamento |
| **Attenuazione** | Aggiungere caveat a un macaroon senza la chiave del server |
| **Caveat** | Restrizione dentro un macaroon (`chiave operatore valore`) |
| **Challenge** | La risposta 402 con macaroon e payment request |
| **Channel / canale** | Deposito payer → provider per un token |
| **Cumulative floor** | `claimed + refunded`: il prossimo voucher deve superarlo |
| **Data limite** | L'ultimo istante in cui un voucher è incassabile |
| **EIP-712** | Standard per firmare dati strutturati in modo leggibile e non riutilizzabile altrove |
| **Gatekeeper** | Il componente del server che emette challenge e verifica i pagamenti |
| **Macaroon** | Credenziale con firma HMAC a catena e caveat |
| **MCP** | Model Context Protocol: il protocollo con cui gli agenti usano i tool dei server |
| **Payer / provider** | Chi paga / chi incassa |
| **Payment request** | L'equivalente EVM della fattura Lightning, dentro la challenge |
| **Session key** | Chiave delegata che firma voucher entro un tetto on-chain |
| **Settler** | Il servizio che incassa i voucher on-chain |
| **Voucher** | Autorizzazione firmata a incassare un totale cumulativo |
