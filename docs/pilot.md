# Live pilot: attested events from a real multi-store operation

The pilot feeds PixSettle with a **signed, pseudonymized copy** of the events of our own multi-store Pix operation on the Brazil-Paraguay border (Equilibrium and partner stores). The store keeps charging through its own rails; nothing in its checkout or money flow changes. PixSettle reconciles every order against its charges and payments, opens an exception for anything that is not "one charge, one payment, right amount, on time", and hands the exception to the [copilot](ai-copilot.md).

Page: `/pilot`. API: `GET /pilot/api/summary`, `GET /pilot/api/exceptions`, `GET /pilot/api/exceptions/:id`.

## What leaves the store, and what never does

| Leaves the store | Never leaves the store |
| --- | --- |
| amounts (BRL, two decimals), UTC timestamps, states, exception type, rail name (`eulen`, `asaas`...) | customer or payer name, document (CPF/CNPJ), e-mail, phone, address |
| a store code (`equilibrium`, `loja-2`...; partner stores are never named) | product names or descriptions, store names of partners |
| pseudonymous ids: `o_` + 20 letters for orders, `i_` for charges, `w_` for withdrawals. They are HMAC-SHA256 of the real id with a key only the store holds, so the store can map back and PixSettle cannot | real ids, Pix keys, QR codes, copy-and-paste codes, raw provider payloads, credentials |

The exporter on the store side scans its own output for e-mails, CPF patterns and long digit runs and suppresses the data if anything matches. PixSettle's **ingestion guard** (`core/src/pilot/guard.ts`) is independent: it only accepts a closed list of keys, rejects any key that looks personal (`name`, `payer`, `document`, `email`, `phone`, `address`, `product`...), rejects values that look like an e-mail, a CPF or a 10+ digit run, and rejects ids that are not letters only. A rejected line is reported with its reason and never stored.

## Transport

`POST /pilot/v1/events` with `content-type: application/x-pixsettle-batch+json` and `x-pilot-signature: sha256=<HMAC-SHA256 of the raw body with PILOT_HMAC_SECRET>`. Body:

```json
{ "source": "odin", "batch_id": "eventos.ndjson:1", "events": [ { "ev": "order.created", "ts": "2026-10-06T13:09:15Z", "store": "equilibrium", "ord": "o_bfpewtdrnyahztragnpe", "amt": "1272.41", "cur": "BRL", ... } ] }
```

Up to 2000 lines per batch, 4 MB. Each line is stored once (dedupe by the SHA-256 of its canonical JSON) and applied in order of arrival; a line that depends on an order not seen yet is deferred and retried, and marked `unmapped` with the reason after 5 tries. The response counts accepted, duplicate and rejected lines and what processing produced. `core/scripts/pilot-load.ts` sends an NDJSON file in sorted batches:

```bash
PILOT_HMAC_SECRET=... npx tsx scripts/pilot-load.ts --url https://pixsettle.example --file eventos.ndjson --batch 300
npx tsx scripts/pilot-load.ts --file eventos.ndjson --dry   # only runs the guard locally
```

## Event vocabulary

| `ev` | Fields | Effect in PixSettle |
| --- | --- | --- |
| `order.created` | `ord`, `amt`, `cur`, `meth`, `src`, `st`, `pay`, `partner_store` | order `awaiting_payment` for the store's merchant, with a provisional 1 h window |
| `pix.charge.created` | `ord`, `chg`, `prov`, `amt`, `exp` | charge recorded; the order's window becomes the latest charge expiry (30 days when the rail has no expiry); a second charge opens a `duplicate_charge` exception |
| `pix.received` | `ord`, `chg`, `amt`, `late` | the same path as a provider webhook: `applyObservation` -> paid -> settlement intent on Tempo testnet (`PILOT_SETTLE=1`) -> receipt. Amount off: order on hold + `amount_mismatch`. After the window: `late_paid` + `late_payment`. Order already paid through another charge: `duplicate_payment` |
| `pix.duplicate` | `ord`, `chg`, `handled` | `duplicate_payment` flagged by the store itself |
| `pix.charge.expired` / `.failed` / `.cancelled` / `.refunded` | `ord`, `chg` | charge state; `expired_unpaid` / `charge_failed` when the order has no other open charge; `.refunded` on the paid charge is a provider-observed refund |
| `order.refund.requested` / `.pending` / `.completed` / `.rejected` | `ord`, `amt`, `how` | `merchant_refund` case: requested (exception `refund_requested`), confirmed with a `refund_notice` receipt, or failed |
| `order.cancelled` | `ord`, `by` | unpaid order closes as expired; open informational exceptions close |
| `med.reported` / `med.handled` | `ord`, `amt`, `st` | **real** MED claim: `med_attested` refund case (open, blocks new settlement) and a high-severity `med_reported` exception |
| `manual.charge.confirmed` / `.divergent` | `ord`, `amt`, `rcv` | payer self-identified in a link: a divergent amount is a `manual_divergent` exception |
| `wallet.withdrawal.*`, `wallet.customer_withdrawal.*`, `wallet.move.*`, `order.return.*`, `pix.tx.*` | | counted for the dashboard; `wallet.withdrawal.failed` and `wallet.move.withdrawal_reversal` open exceptions |

`provider_env` of these orders is `attested`: the periodic sweep and the active expiry never query a provider for them, and refund cases wait for the store's attestation instead of calling a provider.

## Testnet settlement and quotes

With `PILOT_SETTLE=1` (default) each real paid order gets an immutable settlement intent and a `transferWithMemo` on Tempo testnet, like any demo order, and a signed receipt. The pilot quote is **simulated and scaled down** (`PILOT_RATE_NUM/DEN`, default 1 token unit per cent, so R$ 1,00 = 0.0001 pathUSD) to fit a testnet treasury. `PILOT_SETTLE=0` reconciles only and records `settlement_skipped` on each paid order with the reason.

## Environment

| Variable | Meaning |
| --- | --- |
| `PILOT_HMAC_SECRET` | shared secret of the batch signature (required to ingest; without it every batch is refused with the reason) |
| `PILOT_OPERATOR_TOKEN` | bearer token for operator decisions and `POST /pilot/v1/process` |
| `PILOT_SOURCE` | default source id (`odin`) |
| `PILOT_SETTLE`, `PILOT_RATE_NUM`, `PILOT_RATE_DEN`, `PILOT_MERCHANT_ADDRESS` | settlement on/off, scaled quote, payout address of the pilot merchants on testnet |

## First load (90 days, 7 stores, 06/10/2026)

9,144 exported lines, 0 rejected by the guard. 1,195 orders (R$ 935k, 582 paid, R$ 422k), 1,214 charges, 586 payments, 5 refunds, 2 MED claims, 221 withdrawals. Exceptions: 493, of which **479 closed by deterministic rules** (179 repeated charges, 229 expired unpaid, 44 failed charges, 27 withdrawal reversals) and **14 waiting for judgement** (4 amount mismatches, 2 MED claims, 8 failed withdrawals). Zero late payments, zero duplicate payments in the window.
