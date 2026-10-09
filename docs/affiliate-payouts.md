# Affiliate payouts in digital dollars (phase 2 contract)

Status: contract v2, 2026-10-09 (v1 plus the Codex review of task 347, findings P1-1 to P2-13, all applied; see section 10).
Module `core/src/affiliates/`, feature flag `AFFILIATE_PAYOUTS` (off by default).
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
  `rate_num/rate_den` (token units per BRL cent), `quote_source`, `quote_at`, `quote_hash`, `quote_mode`
  (`at_pix` when the event reached PixSettle within 15 minutes of `occurred_at`, otherwise `backfill`: a historical
  import quoted later than the Pix, and shown as such everywhere). `custody`, fixed at release: `pool` (the dollars are
  earmarked in the merchant pool and form the withdrawable balance) or `own_wallet` (paid straight to the beneficiary's
  wallet; never part of the withdrawable balance).
  States: `pending` → `released` → `settling` → `settled`; `pending|released|settling` → `voided` (settling only while
  no attempt may have left for the network); `settling` → `failed`.
- `affiliate_ledger`: append only (database trigger). Kinds: `credit_pending`, `release`, `void`, `settle`, `withdraw_pix`,
  `withdraw_pix_reversal`, `withdraw_wallet`, `withdraw_wallet_reversal`, `fee`, `adjustment`. The ledger is the audit
  trail; balances are derived from states: `pending` = pending commissions; `available` = released, settling or settled
  commissions with `custody = pool` minus withdrawals requested, paid, settling or settled; `paid_to_own_wallet` and
  `in_flight_to_own_wallet` are reported separately and never add to `available`.
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
- `commission.voided` (cancellation, refund, MED, fraud) is safe by settlement state. `pending`: voided. `released`
  (intent recorded, no job): the settlement is closed with `hold_reason = commission_voided` and the commission voided.
  `settling` with no attempt that may have left for the network (none, or only `nonce_reserved`/`signed`): the settlement
  gets the hold first, so the journal suspends the signed attempt at the pre-broadcast check (R2: the treasury queue
  pauses until a person resolves it) and the commission is voided; nothing is transmitted. `settling` with an attempt
  that may have been sent (`broadcast_pending`, `broadcast_sent`, `unknown`, `manual_review`, `confirmed`): refused with
  409 `payout_in_flight`, the reconciliation continues and an exception `affiliate_clawback_needed` is recorded for a human.
  `settled`: refused with 409 `already_settled` and the same exception. Money already on chain is never pulled back silently.
- A void never leaves a balance negative: when the commission is in `pool` custody and a Pix withdrawal already consumes
  it, the void is refused with 409 `withdrawal_in_progress` and the exception is recorded; once the withdrawal is
  reported `failed` the balance returns and the void goes through. Each refusal records one exception per reason code.
- Blockers for an affiliate payout settlement: `affiliate_settle_off` (settlement switch off), settlement hold, commission
  voided or failed, withdrawal failed, orphan settlement, treasury paused. Order and refund blockers do not apply.
- Settlement switch: `AFFILIATE_SETTLE=1` is the only value that signs and broadcasts affiliate payouts. Absent or any
  other value: releases record the intent with `hold_reason = affiliate_settle_off` and jobs already queued are blocked
  at the journal with the same reason (a reserved attempt is suspended, R2). When the switch is turned on, the server
  resumes the stopped settlements (`resumeAffiliateSettlements`: hold cleared, commission `settling`, job requeued).

## 5. Withdrawals

- `POST /simulate` returns the exact numbers for a Pix withdrawal: `usd_units`, `rate` (sell side), `gross_minor`,
  `fee_minor` (merchant's `withdrawal_fee_bps` plus fixed `withdrawal_fee_minor`, both may be 0 during a
  promotion), `net_minor` (what the person receives, exact), `expires_at` (120 s), `lock_id`.
- `POST /withdrawals` with the lock creates the withdrawal. Pix kind: PixSettle records the promise and the
  ledger debit; the merchant pays the Pix from its own BRL inflow (netting) and reports `paid` with the
  end-to-end id, or `failed` with a reason, which credits the balance back. Wallet kind: a settlement with memo
  `wdr_<ULID>` to the registered wallet; fee 0 by default (Tempo transfers cost under a cent).
- Every amount shown is the amount promised; the receipt repeats it.
- Evidence is named, never implied: a Pix `paid` is the merchant's declaration (`evidence: declared_by_merchant`; the
  end-to-end id is kept for the merchant, not published); a wallet `settled` is observed on chain (`chain_confirmed`).
  PixSettle does not verify the Pix at the provider in this phase.

## 6. API (merchant key, same auth as orders)

- `POST /api/v1/affiliates/commissions` body `{ source_event_id, beneficiary_ref, kind, order_ref, amount: {amount, currency: 'BRL', scale: 2}, occurred_at }` → 201 commission; 200 when the same `source_event_id` already exists with the same content (decided under a lock per event id, so concurrent repeats create one); 409 `idempotency_conflict` when the content differs (beneficiary, kind, amount, order or date): the fixed commission never changes.
- `beneficiary_ref` must be opaque by construction: `^(aff|par|afl|ben)_[0-9a-f]{12,64}$`; anything else (a name, CPF, e-mail or Pix key) is refused with `invalid_beneficiary_ref`.
- `POST /api/v1/affiliates/commissions/:id/release` and `/void` body `{ reason_code, occurred_at }`.
- `GET /api/v1/affiliates/beneficiaries/:ref` → balances (`pending`, `available`, `withdrawn`), rate now, list of commissions with receipts.
- `PUT /api/v1/affiliates/beneficiaries/:ref/wallet` body `{ address }` → registers the own wallet.
- `POST /api/v1/affiliates/beneficiaries/:ref/withdrawals/simulate` body `{ kind, usd_units }` → lock.
- `POST /api/v1/affiliates/withdrawals` body `{ lock_id }` → withdrawal; `POST /api/v1/affiliates/withdrawals/:id/paid|failed`.
- `GET /api/v1/affiliates/summary` (merchant aggregate: counts, sums, quote modes, withdrawals with evidence, exceptions for a human, settlement switch) and `GET /api/v1/affiliates/receipts/:id` (the merchant's own receipts).
- Public, read only, and only when `AFFILIATE_PUBLIC_MERCHANT_ID` names the public merchant (without it none of these routes exists): `GET /pilot/api/affiliates` (that merchant's aggregate; exceptions counted in the same scope), `GET /pilot/api/affiliates/:ref` (one pseudonymous beneficiary of that merchant) and `GET /pilot/api/affiliates/receipts/:id` (that merchant's receipts only). Public projections are allow-lists: commissions carry id, status, custody, amounts, quote and payout `{status, hold_reason, memo, tx_hash, receipt_id}`; withdrawals carry kind, status, evidence and amounts. Never the payout destination, the Pix end-to-end id, the merchant's event or order references, or the beneficiary's wallet address (only the mode).
- Read-only replica: when the installation runs `PUBLIC_REPLAY_READ_ONLY=1`, every affiliate write (merchant API and producer batches) is refused with 403 `affiliates_read_only` / `commission_read_only` unless `AFFILIATE_ALLOW_WRITES_ON_PUBLIC_REPLAY=1` says explicitly that affiliate writes enter there; queued apply jobs wait with the reason `writes_off`.
- Errors follow the core shape `{ error: { code, message, details } }`; every refusal has a stable code and a plain-language message.

## 7. Invariants and tests

- Money is integer with currency and scale; one conversion function; rounding down.
- Idempotent by `(merchant_id, source_event_id)`; release and void are idempotent; a void after settle never mutates chain state.
- Durable journal before any broadcast; retries resend the same bytes; unknown outcomes stay reconcilable (inherited).
- `trace_id` per commission: the source event id, the settlement id, the attempt id and the receipt id are linked in the ledger and shown on the detail view.
- Feature flag off: no route is registered, no table is read by existing flows, the public pilot does not change; jobs already queued for affiliates wait (apply) or are blocked at the journal (settle) with the reason recorded.
- The down migration refuses to run while any affiliate payout settlement, commission, withdrawal, ledger row or signed revision exists: a rollback never deletes economic state.
- The public receipt carries the commission (`com_`) or withdrawal (`wdr_`) id, custody and quote mode; never the merchant's order reference or event id.
- Tests (`core/test/affiliates*.test.ts`): conversion and rounding; idempotency (same content 200, different content 409, five concurrent repeats create one); release → settlement → receipt on the fake chain; void pending, released, settling before broadcast (attempt suspended, nothing mined), settling after broadcast (`payout_in_flight`), settled (`already_settled`), with a Pix withdrawal pending (`withdrawal_in_progress`); own-wallet custody out of the available balance; settlement switch off blocks queued jobs and resume on switch on; read-only replica refuses writes; down migration guard; public allow-lists and receipt scope; opaque refs; `at_pix` vs `backfill`; batch application maps refused voids to `skipped_*` with the exception recorded. 272 tests in the core suite.

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

## 10. Review of task 347 (Codex, 2026-10-09) and what changed

The static review (`REVISAO-347-BASE.md`) blocked promotion with 13 findings; contract v2 applies all of them.
P1-1 own-wallet double count → `custody` fixed at release, balances derived per custody. P1-2 void during settling →
state-safe void: hold before void, signed attempt suspended, `payout_in_flight` once sent. P1-3 negative balance →
`withdrawal_in_progress`. P1-4 settle switch → only `AFFILIATE_SETTLE=1` settles; writes on the read-only replica need
the explicit opt-in. P1-5 queued jobs with the switch off → journal blocker `affiliate_settle_off`, apply waits with
`writes_off`/`affiliates_off`. P1-6 down migration → guard on every economic table. P1-7 public leaks → allow-list
projections, receipts scoped to the public merchant. P1-8 missing public merchant → no public route at all. P1-9 refs →
opaque regex enforced. P2-10 quote presented as Pix-time → `quote_mode = backfill` beyond 15 minutes, shown on the page,
the summary and the receipt. P2-11 idempotent repeat with different content → 409 `idempotency_conflict`. P2-12 race →
decision under `affiliate:idem:<merchant>:<event>` lock. P2-13 declared vs verified → `evidence` on every withdrawal view
and on the aggregate; the fake chain in tests is named as such (nothing here claims a Moderato run).

Canonical interfaces, as agreed with the producer: the signed batch (section 9) is the path for the producer that already
exports the pilot; the merchant-key API (section 6) is the path for the merchant hub and any other client. Both end in the
same domain functions. The 23 `commission.observed` events already collected privately will enter as `backfill` and be
labelled so; a dedicated `commission` key (`AFFILIATE_KEYS_JSON`) is required, never the pilot HMAC.
