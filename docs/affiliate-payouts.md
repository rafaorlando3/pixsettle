# Affiliate payouts in digital dollars (phase 2 contract)

Status: contract v1, 2026-10-09. Module `core/src/affiliates/`, feature flag `AFFILIATE_PAYOUTS` (off by default).
Scope of this phase: real commission events from the merchant's affiliate program enter PixSettle through the
API, each commission is fixed in digital dollars at the moment the Pix is received, released after the
merchant's own hold, paid on Tempo with one `transferWithMemo` per commission, and withdrawn either to Pix
(exact BRL shown before confirming) or to the beneficiary's own wallet. Everything is an API so the same
engine serves the public pilot page, the merchant hub and any other client.

## 1. Why

The merchant hub already runs an affiliate program (rewards per order, released after delivery plus a
grace period, voided on cancellation, refund, MED or fraud). Payouts today are BRL credits withdrawn by Pix.
This phase changes only the currency the balance is kept in: digital dollars (OUSD on Tempo, pathUSD on the
Moderato testnet), with a public receipt per commission and an exact amount on every Pix withdrawal. The
beneficiary never has to understand crypto; the rule says in one sentence that the balance is kept in
digital dollars on the Tempo network.

## 2. Entities and ids

- `affiliate_beneficiaries` (`ben_`): one per `(merchant_id, beneficiary_ref)`. `beneficiary_ref` is an opaque
  hash supplied by the merchant (never a name, CPF or Pix key). `kind` is `affiliate` or `partner_percent`.
  `payout_address` is the beneficiary's own wallet when registered; while null, payouts go to the merchant's
  affiliate pool address and the memo identifies the commission.
- `affiliate_commissions` (`com_`): one per source commission event (`source_event_id` unique per merchant).
  Money: `amount_minor` (BRL, scale 2, integer) and `usd_units` (token units, scale 6, integer). Quote fields:
  `rate_num/rate_den` (token units per BRL cent), `quote_source`, `quote_at`, `quote_hash`.
  States: `pending` → `released` → `settling` → `settled`; `pending|released` → `voided`; `settling` → `failed`.
- `affiliate_ledger`: append only. Kinds: `credit_pending`, `release`, `void`, `settle`, `withdraw_pix`,
  `withdraw_wallet`, `fee`, `adjustment`. Balance = sum of signed `usd_units` per beneficiary; `available` counts
  only released commissions not yet withdrawn.
- `affiliate_quote_locks` (`qlk_`): a withdrawal simulation with the exact BRL, valid for 120 s, single use.
- `affiliate_withdrawals` (`wdr_`): `kind` `pix` or `wallet`; `pix` carries `net_minor` (exact BRL promised),
  `fee_minor`, the lock, and `pix_e2e_id` once the merchant reports the Pix; `wallet` carries the on-chain
  settlement.
- Settlements for payouts reuse the durable send journal: `settlements.kind = 'affiliate_payout'`,
  `order_id` null, `beneficiary_ref` set, memo `com_<ULID>` (commission) or `wdr_<ULID>` (wallet withdrawal).

## 3. Conversion rule (fixed at Pix time)

1. The merchant posts `commission.created` as soon as its Pix is confirmed (card orders: when the card
   funds land). The event carries `amount_minor` in BRL.
2. PixSettle quotes once, immediately, from the configured quote source (`simulated` in tests and the public
   replay; `binance_usdtbrl` live, with staleness and error reasons recorded). The conversion cost configured
   for the merchant (`conversion_fee_bps`, default 0) is deducted before fixing `usd_units`.
3. `usd_units = floor(amount_minor × (1 − fee) × rate_num / rate_den)`. Rounding is always down in token
   units; the remainder stays with the merchant. The rate, source, time and a hash of the quote are stored
   on the commission and shown on the receipt.
4. From that moment the beneficiary sees "you will receive US$ X (R$ Y at purchase)". The number never
   changes during the hold.

## 4. Release, void and payout

- `commission.released` (the merchant's own rule: delivery plus grace, or the fixed hold) moves the commission
  to `released` and enqueues a settlement from the treasury to the beneficiary's payout address with memo
  `com_<ULID>`; the existing journal signs, broadcasts, reconciles and issues the receipt. On confirmation the
  commission is `settled` and the ledger gets `settle`.
- `commission.voided` (cancellation, refund, MED, fraud) on a `pending` or `released` commission that has
  not been settled voids it with the merchant's `reason_code`; the ledger gets `void` for the same `usd_units`.
  A void after settlement is recorded as an exception (`affiliate_clawback_needed`) for a human: money already
  on chain is never pulled back silently.
- Blockers for an affiliate payout settlement: commission voided, beneficiary without payout address and
  no pool configured, treasury paused. Order and refund blockers do not apply.

## 5. Withdrawals

- `POST /simulate` returns the exact numbers for a Pix withdrawal: `usd_units`, `rate` (sell side), `gross_minor`,
  `fee_minor` (merchant's `withdrawal_fee_bps` plus fixed `withdrawal_fee_minor`, both may be 0 during a
  promotion), `net_minor` (what the person receives, exact), `expires_at` (120 s), `lock_id`.
- `POST /withdrawals` with the lock creates the withdrawal. Pix kind: PixSettle records the promise and the
  ledger debit; the merchant pays the Pix from its own BRL inflow (netting) and reports `paid` with the
  end-to-end id, or `failed` with a reason, which credits the balance back. Wallet kind: a settlement with memo
  `wdr_<ULID>` to the registered wallet; fee 0 by default (Tempo transfers cost under a cent).
- Every amount shown is the amount promised; the receipt repeats it.

## 6. API (merchant key, same auth as orders)

- `POST /api/v1/affiliates/commissions` body `{ source_event_id, beneficiary_ref, kind, order_ref, amount: {amount, currency: 'BRL', scale: 2}, occurred_at }` → 201 commission (idempotent by `source_event_id`).
- `POST /api/v1/affiliates/commissions/:id/release` and `/void` body `{ reason_code, occurred_at }`.
- `GET /api/v1/affiliates/beneficiaries/:ref` → balances (`pending`, `available`, `withdrawn`), rate now, list of commissions with receipts.
- `PUT /api/v1/affiliates/beneficiaries/:ref/wallet` body `{ address }` → registers the own wallet.
- `POST /api/v1/affiliates/beneficiaries/:ref/withdrawals/simulate` body `{ kind, usd_units }` → lock.
- `POST /api/v1/affiliates/withdrawals` body `{ lock_id }` → withdrawal; `POST /api/v1/affiliates/withdrawals/:id/paid|failed`.
- Public, read only: `GET /pilot/affiliates` (aggregate: beneficiaries, commissions, USD fixed, settled on chain, exceptions) and `GET /pilot/affiliates/:ref` (one pseudonymous beneficiary: commissions, receipts, withdrawals).
- Errors follow the core shape `{ error: { code, message, details } }`; every refusal has a stable code and a plain-language message.

## 7. Invariants and tests

- Money is integer with currency and scale; one conversion function; rounding down.
- Idempotent by `(merchant_id, source_event_id)`; release and void are idempotent; a void after settle never mutates chain state.
- Durable journal before any broadcast; retries resend the same bytes; unknown outcomes stay reconcilable (inherited).
- `trace_id` per commission: the source event id, the settlement id, the attempt id and the receipt id are linked in the ledger and shown on the detail view.
- Feature flag off: no route is registered, no table is read by existing flows, the public pilot does not change.
- Tests: conversion and rounding; idempotency of create/release/void; release → settlement → receipt on the fake chain; void before and after settlement; withdrawal simulation and lock expiry; Pix paid/failed; wallet withdrawal; public projections carry no personal data.

## 8. Out of scope for this phase

Real BRL to OUSD purchases (the merchant hub's route desk does that in batches), TIP-1022 virtual addresses
per beneficiary (pool address with memo until then), regulatory sign-off on USD-denominated balances, and
real affiliates on mainnet. Customer money is never touched: refunds and cancellations that go back to the
customer's wallet stay in BRL exactly as paid and are withdrawn through the merchant's existing Pix rail; only
the affiliate or partner commission attached to that order is reversed here.

## 9. Signed batch ingestion (producer contract)

Besides the merchant-key API in section 6, the producer that already exports the pilot can post commissions as
signed batches (`pixsettle-commission-batch/1`, events `pixsettle-commission-event/1`, type `commission.observed`)
to `POST /pilot/affiliates/v1/batches`: exact canonical bytes with one trailing LF, HMAC of the batch with a
key scoped to `commission`, Bearer token per origin, `X-Pixsettle-Key-Id`, strict chain by `previous_batch_sha256`
(409 `commission_chain_gap`), exact replay returns the stored receipt with `x-pixsettle-replayed: true`, 423 when
the stream is busy, 503 when the keys are not configured. Phase 1 stores revisions, batch and a signed receipt
(`pixsettle-commission-receipt/1`) in append-only tables and never depends on a quote. Phase 2 (outbox job
`apply_commission_revisions`) applies each new revision to the domain in order: first observation `pending` or
`review` creates the commission (fixing the dollars at that moment), `active` releases it, `voided` or `lost` voids
it with the producer's `reason_code`; an observation that is already voided on first sight creates nothing; an
amount change after the dollars were fixed is recorded as `affiliate_amount_changed` for a human and leaves the
commission untouched. Each revision gets exactly one application row (`created`, `released`, `voided`, `unchanged`,
`skipped_*`, `failed:<code>`); a quote outage or a stream not yet mapped to a merchant (`AFFILIATE_STREAMS_JSON`,
`{"src_odin|store_1": "mer_..."}`) is retried with the reason recorded, never silently dropped. Beneficiary ids
`aff_...` are affiliates and `par_...` are partners paid by percentage.
