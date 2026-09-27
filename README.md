# PixSettle

**Pix in, stablecoin out, with a receipt anyone can verify.**

PixSettle lets merchants who sell to Brazilians accept Pix (the instant payment system used by about 148 million people in Brazil at the end of 2025, per the Central Bank) and receive the money as a dollar stablecoin on [Tempo](https://tempo.xyz). We start with Paraguay's border shops, where Brazilian shoppers already pay with Pix and merchants want dollars. Three guarantees that payment rails usually leave to trust:

1. **The merchant is never paid twice**, even when the Pix provider sends the same webhook five times, a worker crashes mid-send, or the RPC times out after accepting the transaction.
2. **Refunds and fraud claims are controlled.** In Brazil a payer can ask their bank to claw back a Pix through MED (the special return mechanism) for up to 80 days. PixSettle keeps a rolling reserve per merchant, blocks refunds while a settlement is in flight, and never signs a settlement while a refund is open.
3. **Every settlement has a receipt anyone can verify** in their own browser: the issuer's signature over the canonical JSON, and the Tempo transaction read straight from the public RPC, without trusting our server.

Built for the Colosseum Crypto World's Fair, Tempo track.

> **Demo status, stated plainly.** The Tempo side is real: settlements are `transferWithMemo` transactions on Tempo testnet (Moderato, chain id 42431) in pathUSD. The Pix side runs on a **simulated provider** in the public demo (an Asaas sandbox adapter is in progress). The FX quote and the merchant reserve are **simulated accounting**, labeled as such on every screen and receipt. No real money moves. In production, BRL to stablecoin conversion must go through a partner licensed by the Central Bank of Brazil; PixSettle is software on top of that partner and does not hold customer funds.

## How it works

```
Payer ── Pix ──> Pix provider ── webhook (at least once) ──> core
                                                     │
                   durable event + outbox (same DB transaction)
                                                     │
                     query provider: RECEIVED, PIX, same amount, same order?
                                                     │
                     immutable settlement intent (to, amount, memo)
                                                     │
          settlement signer (only process with keys, localhost + HMAC)
                                                     │
        nonce reserved under lock -> sign offline -> store bytes and hash
                   -> broadcast -> reconcile by hash -> confirmed
                                                     │
                    signed receipt (JCS + SHA-256 + EIP-191) -> /receipt/:id
```

- **Send journal.** Each settlement has at most one active attempt. The nonce is reserved under a treasury lock and tied to a durable attempt. The signed bytes and hash are stored before broadcasting. On timeout we reconcile by hash and only ever rebroadcast the same bytes: never a new nonce, never a new signature. Unknown outcomes go to manual review instead of guessing.
- **Treasury pause.** If a signed transfer must not go out (for example, a refund arrived between signing and sending), it is suspended with its bytes and nonce preserved, and later transfers from the same treasury wait with a diagnostic instead of piling up behind it.
- **Memo reconciliation.** Every transfer carries a 32-byte memo with the settlement id. A transfer only counts if chain id, token, sender, recipient, amount and memo all match.
- **Refunds.** Merchant refunds go through the API with an idempotency key; a refund is confirmed only after the provider shows it. After settlement, the merchant's simulated reserve covers the exposure first and any remainder becomes simulated merchant debt. Every refund gets a `refund_notice` receipt linked to the previous one.
- **Receipts.** RFC 8785 canonical JSON, SHA-256 digest, EIP-191 signature over a message that binds environment, chain and digest. A Python verifier and shared test vectors keep the format honest across languages.

## Try it locally

Requires Node 22 and PostgreSQL 16. You also need a local JSON file with **testnet** keys (never commit it): `{"treasury": "0x...", "merchant": "0x...", "issuer": "0x..."}` (issuer optional). Fund the treasury with pathUSD from the Tempo testnet faucet.

```bash
cd core && npm ci && cd ../settlement && npm ci && cd ../web && npm ci && npm run build && cd ../core
DATABASE_URL=postgres://user@localhost/pixsettle_demo E2E_KEYS=/path/to/keys.json npx tsx scripts/dev-demo.ts
# open http://127.0.0.1:8080/demo
```

Pages:

- `/demo` operator console: create an order through the real merchant API, pay it with the simulated provider (the webhook is delivered 3 times on purpose), watch the settlement timeline, refund, open a simulated MED claim.
- `/pay/:token` payer checkout: QR code, copy and paste code, expiry.
- `/receipt/:id` receipt verified in your browser. Add `?issuer=0x...` to pin the issuer you trust.

In production the signer and the core run as two processes: `settlement/src/server.ts` (keys, localhost only, HMAC with replay protection) and `core/src/server.ts` (API, pages, worker; no keys).

## Repository

| Folder | What |
| --- | --- |
| `contract/` | Core contract (in Portuguese), receipt test vectors, independent Python verifier |
| `settlement/` | Signer: sign, broadcast and observe `transferWithMemo` on Tempo (TypeScript, viem) |
| `core/` | Orders, Pix charges, provider events, send journal, refunds, ledger, receipts, API, pages, demo |
| `web/` | Operator console, payer checkout, receipt page and in-browser verifier |

## Tests

```bash
cd settlement && npx vitest run   # signer, receipts, broadcast error classification
cd core && npx vitest run         # needs PostgreSQL (TEST_DATABASE_ADMIN); one fresh database per test
python3 contract/tools/verify_receipt_vectors.py
```

The core suite covers duplicate webhooks, two workers racing for the same settlement, a crash at every step of the send journal, lost RPC responses, reverted transactions, amount mismatch, stale provider events, late payments, refunds racing settlements, external refunds, and expired checkout links. Several cases were written by an independent reviewer and are kept unchanged.

## Roadmap

- Asaas sandbox adapter (real Pix in sandbox), periodic reconciliation with the provider and webhook liveness alerts.
- Licensed FX partner integration and real quotes.
- On-chain reserve with an explicit release policy (today the reserve is accounting only).
