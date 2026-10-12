# PixSettle

**Reconcile Pix payments, handle exceptions, verify every settlement.**

[![tests](https://github.com/rafaorlando3/pixsettle/actions/workflows/tests.yml/badge.svg)](https://github.com/rafaorlando3/pixsettle/actions/workflows/tests.yml)

## What is real today (12 Oct 2026)

| | Network | Real money? | Check it |
|---|---|---|---|
| **Affiliate dollars, in production on our own store since 11 Oct 2026** | Tempo mainnet (4217), USDC.e | **Yes.** R$ 361.83 of our own BRL bought 69.475862 USDC, sent in 3 on-chain transfers to the store treasury. 6 commissions to 5 affiliates are fixed at US$ 57.76; 3 withdrawals were paid by Pix (US$ 19.51). On-chain payouts are off: affiliates withdraw by Pix in BRL and the USDC stays in the treasury. | [Live page](https://epluspy.com/transparencia/dolar) · [treasury](https://explore.tempo.xyz/address/0xb2d7d888E8415F076A3BA4215F0686810a510265) · [first transfer](https://explore.tempo.xyz/tx/0xb8e14a51957aaf4f5c83113d5a3b9023f0fb7c93450d5631864e7afa54022ccd) · engine [`affiliates-production-v7.5.2`](https://github.com/rafaorlando3/pixsettle/tree/affiliates-production-v7.5.2) |
| **Shadow pilot** on our own stores | None: it settles nothing | Reads real store events, pseudonymized and signed: 1,269 orders, 622 Pix observed, 617 matched exactly, 10 exceptions waiting for a human, none decided yet (8 Jul to 10 Oct 2026; the feed is paused since then). "Observed" means a validated provider event, not a bank statement. | [/pilot](https://pixsettle-demo.onrender.com/pilot) · [summary API](https://pixsettle-demo.onrender.com/pilot/api/summary) |
| **Hosted demo** | Tempo testnet (Moderato, 42431), pathUSD | No. The Pix provider, the FX quote and the merchant reserve are simulated and labelled on screen. | [/demo](https://pixsettle-demo.onrender.com/demo) |
| **A deposit address per order (TIP-1022) and a receive policy (TIP-403)** | Tempo testnet (Moderato) | No: faucet test tokens. Seven payments, seven outcomes reconciled from the chain logs, repeated from a clean state. | [Docs and explorer links](docs/tempo-deposit-addresses.md) · [order paid with no memo](https://explore.testnet.tempo.xyz/tx/0xe8c5ee082739181654601375176f2f1028f8fc40a450ac170714d40551c30f94) |

**Safety by design.** Deterministic rules decide first. The copilot's model only sees what the rules cannot settle, gives advice and never moves money on its own; irreversible actions need human confirmation. A durable send journal stops a payment from going out twice.

## For judges: quick guide

[Pitch](https://youtu.be/sHc_tnyOXoo) · [Demo video](https://youtu.be/AKpbzwSIBmA) · [Hosted demo](https://pixsettle-demo.onrender.com/demo) · [Shadow pilot](https://pixsettle-demo.onrender.com/pilot) · [Release v1.2.0](https://github.com/rafaorlando3/pixsettle/releases/tag/v1.2.0) · [Failure matrix](https://github.com/rafaorlando3/pixsettle/blob/51d7e92471b6217115ec9cb4c8e2ab0f97e369ed/docs/coverage.md)

1. **Hosted demo (2 min).** Click **Create Pix charge**, then **Payer pays, webhook delivered 3 times**: three deliveries, one settlement, one receipt. Open the receipt; its on-chain fields (network, token, sender, recipient, amount, memo) are checked in your browser against the public Tempo RPC. Pix is simulated in the public demo. Settlement is a real `transferWithMemo` on Tempo testnet (Moderato, chain id 42431) in pathUSD. FX and the merchant reserve are simulated accounting. No real money moves in the demo.
2. **Shadow pilot (1 min).** A read-only view of pseudonymized, merchant-attested Pix events from our own multi-store operation on the Brazil-Paraguay border, with recorded advisory reviews. "Observed" means a validated provider event, not a bank statement. The pilot does not settle orders and makes no paid model calls. Current totals: [/pilot/api/summary](https://pixsettle-demo.onrender.com/pilot/api/summary).
3. **Affiliate rail (30 s).** Commissions are fixed in digital dollars; once released, eligible commissions settle on Tempo testnet with one memo and one signed receipt. Imported history is labelled as quoted after its Pix. The merchant's Pix attestation and the on-chain wallet evidence are shown separately. In the hosted demo this rail runs on testnet and withdrawals are off; in production our store runs it on mainnet, with withdrawals paid by Pix and on-chain payouts off (first row of the table above). Demo totals: [/pilot/api/affiliates](https://pixsettle-demo.onrender.com/pilot/api/affiliates).
4. **Tempo deposit addresses (30 s).** Each order can get its own Tempo deposit address (TIP-1022) and the merchant wallet runs a receive policy (TIP-403): payments are matched to their order without a memo, and a token the merchant does not accept is held on-chain with a receipt the payer can reclaim. Testnet rules and live runs on Moderato (for example, [an order paid with no memo](https://explore.testnet.tempo.xyz/tx/0xe8c5ee082739181654601375176f2f1028f8fc40a450ac170714d40551c30f94)); the hosted checkout does not issue deposit addresses yet. Explorer links, outcomes and how to reproduce: [`docs/tempo-deposit-addresses.md`](docs/tempo-deposit-addresses.md).

**Explore the demo.** Open the hosted demo and click **Create Pix charge**, then **Payer pays, webhook delivered 3 times**. This exercises duplicate delivery with a simulated Pix provider and settlement on Tempo testnet. Open the receipt to check its on-chain fields against the public Tempo RPC. **Payer sends R$ 0,01 less**, **Merchant refunds R$ 10,00** and **Payer opens a MED claim** exercise exception paths. Then open the shadow pilot to inspect pseudonymized, merchant-attested events in read-only shadow mode, with recorded advisory verdicts. The policy permits eligible reversible actions; irreversible actions require human confirmation. The first visit can take longer after an idle period.

PixSettle is a reconciliation and exception-handling prototype for merchants who receive Pix, Brazil's instant payment system (almost 80 billion payments and more than R$ 35 trillion in 2025, according to the Banco Central do Brasil). It links each order to the provider's payment status, a controlled settlement in a dollar stablecoin on [Tempo](https://tempo.xyz) and a receipt anyone can verify. Duplicate webhooks, interrupted processing, refunds and uncertain RPC responses are explicit states that must be reconciled before another action is allowed. The starting market is Paraguay's border shops, where Brazilian shoppers already pay with Pix; merchant demand was checked in an in-person survey of 9 border merchants, and 3 merchants signed letters of interest. The prototype makes three safeguards explicit:

1. **Duplicate settlement is prevented by the send journal.** Repeated webhooks and interrupted processing reuse the existing attempt. An uncertain RPC result requires reconciliation and does not authorize another payment.
2. **Refunds and fraud claims are controlled.** The demo models refunds and MED fraud-return cases as explicit states. PixSettle keeps a rolling reserve per merchant, blocks refunds while a settlement is in flight, and never signs a settlement while a refund is open.
3. **Every settlement has a receipt anyone can verify** in their own browser. The on-chain part (network, token, sender, recipient, amount and memo) is read straight from the public Tempo RPC. The Pix part is the issuer's signed statement, and the page labels it that way: a valid signature does not prove on its own that the Pix was received. If the RPC cannot be reached, the page says the check is unavailable instead of calling the receipt valid or invalid.

Built for the Colosseum Crypto World's Fair, Tempo track.

**Historical pilot and exception copilot.** PixSettle replays a signed, pseudonymized export from a multi-store merchant operation. The public pilot is read-only: deterministic evidence, recorded copilot verdicts and advisory review, with no paid model calls or financial settlement. Current counts must be measured from the deployed shadow projection. Page `/pilot`; details in [`docs/pilot.md`](docs/pilot.md) and [`docs/ai-copilot.md`](docs/ai-copilot.md).

**Affiliate payouts in digital dollars (phase 2, behind `AFFILIATE_PAYOUTS=1`).** The merchant's affiliate program posts each commission the moment its Pix is confirmed, through the merchant-key API or as signed batches from the producer that already feeds the pilot; PixSettle fixes the amount in digital dollars at that instant (quote, source, hash and mode on the receipt; a historical import is labelled as quoted later than its Pix), holds it until the merchant releases it, pays it on Tempo with one `transferWithMemo` per commission through the same durable send journal as orders, and lets the beneficiary withdraw to Pix with the exact BRL amount shown before confirming, or send the dollars to a wallet of their own. Voids follow the order and are safe by settlement state: nothing is pulled back silently, and a commission already on chain becomes an exception for a human. Settlement runs only with `AFFILIATE_SETTLE=1`; the public, pseudonymous page per beneficiary (`/pilot/affiliates/<ref>`) exists only when `AFFILIATE_PUBLIC_MERCHANT_ID` names the public merchant. API, invariants and what never leaves the store are in [`docs/affiliate-payouts.md`](docs/affiliate-payouts.md).

> **Demo status, stated plainly.** The Tempo side is real: settlements are `transferWithMemo` transactions on Tempo testnet (Moderato, chain id 42431) in pathUSD. The Pix side runs on a **simulated provider** in the public demo (an Asaas sandbox adapter is in progress). The FX quote and the merchant reserve are **simulated accounting**, labeled as such on every screen and receipt. No real money moves in the demo. Production use for other merchants would require separately validated provider and FX integrations, operational controls and applicable regulatory arrangements. PixSettle does not hold customer funds: in its one production use, our store's affiliate dollars, the USDC sits in the store's own treasury.

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
- `/pilot` historical shadow replay: observed events, scoped reconciliation and recorded advisory reviews.

In production the signer and the core run as two processes: `settlement/src/server.ts` (keys, localhost only, HMAC with replay protection) and `core/src/server.ts` (API, pages, worker; no keys).

## Repository

| Folder | What |
| --- | --- |
| `contract/` | Historical core design (Portuguese), pilot contract (English), receipt test vectors, independent Python verifier |
| `settlement/` | Signer: sign, broadcast and observe `transferWithMemo` on Tempo (TypeScript, viem) |
| `core/` | Orders, Pix charges, provider events, send journal, refunds, ledger, receipts, API, pages, demo, pilot ingestion (`src/pilot/`) and exception copilot (`src/copilot/`) |
| `web/` | Operator console, payer checkout, receipt page and in-browser verifier |

## Tests

```bash
cd settlement && npx vitest run   # signer, receipts, broadcast error classification
cd core && npx vitest run         # needs PostgreSQL (TEST_DATABASE_ADMIN); one fresh database per test
cd web && npx vitest run          # in-browser receipt verifier against a local fake RPC
python3 contract/tools/verify_receipt_vectors.py
```

The core suite also covers the pilot and the copilot: the ingestion guard (personal data and unknown keys refused with the reason), batch signature and dedupe, out-of-order events, repeated charges, amount mismatch, late and duplicate payments, store-attested refunds and MED claims, rules, policy (reversible only, confidence floor, disagreement), a model that answers garbage, a model that is off, replay without a key, and the operator's decision. The core suite covers duplicate webhooks, two workers racing for the same settlement, a crash at every step of the send journal, lost RPC responses, reverted transactions, amount mismatch and rounding, stale provider events, late payments, refunds racing settlements, external refunds, and expired checkout links. The core suite also covers a process restart with the simulated Pix provider persisted in the database, and a worker that makes no database queries at all when there is nothing to do. The web suite checks that the receipt page reports a receipt that contradicts the chain as failed, and anything the chain did not answer conclusively (RPC unreachable, transaction not found yet, incomplete answer) as unavailable, with the reason. Several cases were written by an independent reviewer and are kept unchanged. The full failure matrix, with the test that covers each scenario and what is still open, is in [`docs/coverage.md`](docs/coverage.md). Every push runs the suites in GitHub Actions (`.github/workflows/tests.yml`).

## Roadmap

- Verifiable receipt links in merchant wallet statements, subject to merchant agreement; verdict hash referenced from the receipt.
- Asaas sandbox adapter (real Pix in sandbox), periodic reconciliation with the provider and webhook liveness alerts.
- Licensed FX partner integration and real quotes.
- On-chain reserve with an explicit release policy (today the reserve is accounting only).

## Deploy and license

- Container deployment with testnet keys derived from a host-generated seed: see `Dockerfile`, `render.yaml` and [`docs/deploy.md`](docs/deploy.md). Verify current hosting terms, capacity and costs before provisioning.
- MIT license (see `LICENSE`).
