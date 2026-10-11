# Affiliate payouts in digital dollars (phase 2 contract)

Status: contract v7, 2026-10-10 (v6 plus the launch quote, declared capabilities and the production profile for real money; see section 15).
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
- Settlement authorization is one predicate for every path (routes, batch apply, resume, advance, sign, broadcast):
  `AFFILIATE_SETTLE=1` AND writes accepted (`PUBLIC_REPLAY_READ_ONLY` absent, or `AFFILIATE_ALLOW_WRITES_ON_PUBLIC_REPLAY=1`).
  Otherwise releases record the intent with `hold_reason = affiliate_settle_off`, jobs already queued are blocked at the
  journal with the same reason (a reserved or signed attempt is suspended, R2: bytes and nonce preserved, nothing sent)
  and nothing is resumed. When the authorization becomes true, the server resumes the stopped settlements
  (`resumeAffiliateSettlements`: hold cleared, commission `settling`, job requeued).
- Void and the send journal are serialized by the journal's own lock order (settlement, then attempt; the commission row
  after the settlement): a void that arrives while the worker is recording `broadcast_pending` waits for the settlement
  lock and, once it has it, re-reads the attempts and refuses with `payout_in_flight`; a void that arrives first sets
  the hold, and the worker's pre-broadcast check suspends the signed attempt. A refused void changes nothing except the
  durable exception row.

## 5. Withdrawals

- `POST /simulate` returns the exact numbers for a Pix withdrawal: `usd_units`, `rate` (sell side), `gross_minor`,
  `fee_minor` (merchant's `withdrawal_fee_bps` plus fixed `withdrawal_fee_minor`, both may be 0 during a
  promotion), `net_minor` (what the person receives, exact), `expires_at` (120 s), `lock_id`.
- `POST /withdrawals` with the lock creates the withdrawal. Pix kind: PixSettle records the promise and the
  ledger debit; the merchant pays the Pix from its own BRL inflow (netting) and reports `paid` with the
  end-to-end id, or `failed` with a reason, which credits the balance back. Wallet kind: a settlement with memo
  `wdr_<ULID>` to the registered wallet; fee 0 by default (Tempo transfers cost under a cent).
- Every amount shown is the amount promised; the receipt repeats it.
- The signed receipt never carries a destination address: `settlement.recipient_sha256` (sha256 of the lowercase
  address) lets the merchant prove the destination without publishing it; the transaction hash is the public proof.
  The public receipt route returns the signed envelope exactly as issued, nothing removed. The browser verifier
  (`web/src/verify.ts`, page `/receipt/<rct_>`) recognises `affiliate_commission_payout` and `affiliate_wallet_withdrawal`,
  checks token, sender, amount, memo, block and log index as for a settlement receipt, and checks the recipient of the
  `TransferWithMemo` log against `recipient_sha256` instead of a `to` field; it never displays the wallet. An affiliate
  receipt that carries `to` is malformed (fail). What the issuer attests (the commission's BRL amount, custody and quote
  mode, or the withdrawal) is shown as an informational step; an RPC that cannot be reached is `unavailable`, never `fail`.
- Evidence is named, never implied: a Pix `paid` is the merchant's declaration (`evidence: declared_by_merchant`; the
  end-to-end id is kept for the merchant, not published); a wallet `settled` is observed on chain (`chain_confirmed`).
  PixSettle does not verify the Pix at the provider in this phase.

## 6. API (merchant key, same auth as orders)

- `POST /api/v1/affiliates/commissions` body `{ source_event_id, beneficiary_ref, kind, order_ref, amount: {amount, currency: 'BRL', scale: 2}, occurred_at }` → 201 commission; 200 when the same `source_event_id` already exists with the same content (decided under a lock per event id, so concurrent repeats create one); 409 `idempotency_conflict` when the content differs (beneficiary, kind, amount, order or date): the fixed commission never changes.
- `beneficiary_ref` must be opaque by construction: `^(aff|par|afl|ben)_[0-9a-f]{12,64}$`; anything else (a name, CPF, e-mail or Pix key) is refused with `invalid_beneficiary_ref`.
- `POST /api/v1/affiliates/commissions/:id/release` and `/void` body `{ reason_code, occurred_at }`.
- `POST /api/v1/affiliates/commissions/:id/adjust` body `{ amount: {amount, currency: 'BRL', scale: 2}, reason_code, occurred_at }` (v7.1): lowers a PENDING commission at its own fixed rate and fee; see section 16.
- `POST /api/v1/affiliates/commissions/:id/retry-payout`: when the send journal gave up on a payout (`settlements.status = failed`, for example after the maximum number of reverted attempts) and no attempt may have reached the network, records a new settlement intent for the same commission with the same memo plus a `-N` suffix (memo is unique in the journal), without touching the ledger. Refused with `payout_not_failed`, `payout_in_flight`, `commission_not_payable` or `no_payout_address`.
- `GET /api/v1/affiliates/beneficiaries/:ref` → balances (`pending`, `available`, `withdrawn`), rate now, list of commissions with receipts.
- `PUT /api/v1/affiliates/beneficiaries/:ref/wallet` body `{ address }` → registers the own wallet.
- `POST /api/v1/affiliates/beneficiaries/:ref/withdrawals/simulate` body `{ kind, usd_units }` → lock.
- `POST /api/v1/affiliates/withdrawals` body `{ lock_id }` → withdrawal; `POST /api/v1/affiliates/withdrawals/:id/paid|failed`.
- `GET /api/v1/affiliates/summary` (merchant aggregate: counts, sums, quote modes, withdrawals with evidence, exceptions for a human, settlement switch) and `GET /api/v1/affiliates/receipts/:id` (the merchant's own receipts, resolved by the real link receipt → commission or withdrawal → beneficiary → merchant; a beneficiary reference is unique only inside a merchant and is never used as a scope).
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
revision that changes any field the commission fixed when it was born (amount, affiliate, kind, order reference or
creation date) is recorded as `affiliate_amount_changed` or `affiliate_identity_changed` for a human and leaves the
commission untouched (nothing is released or voided on the old domain). Each revision gets exactly one application row
(`created`, `released`, `voided`, `unchanged`, `skipped_*`, `failed:<code>`); a quote outage or a stream not yet mapped
to a merchant (`AFFILIATE_STREAMS_JSON`, `{"src_store|store_1": "mer_..."}`) is retried with the reason recorded, never
silently dropped. Revisions are applied in blocks of 500 per job and the job reschedules itself immediately while
revisions remain, so a batch of up to 5,000 is drained in order. Every refused batch (token, key, signature, chain gap,
framing, read-only replica, internal error) is recorded append-only in `affiliate_commission_rejections` with origin
and key id when identifiable, the code, the technical detail, the HTTP status and the sha256 and size of the body
received (`capture = full`); a refusal before the body is read (413 by declared Content-Length, 415 media type) keeps the
declared size (`declared`, stored as bigint, so a declared 3 GB is recorded; a value that is not even a safe integer is
kept in `detail` with a null size) or nothing (`none`, for example chunked without Content-Length). The batch route
accepts only `application/json` (with or without charset); any other media type, or no Content-Type, is 415
`commission_content_type` before any validation, never 413. Beneficiary ids `aff_...` are affiliates and `par_...` are
partners paid by percentage.

## 10. First review (2026-10-09) and what changed

The first static review blocked promotion with 13 findings; contract v2 applies all of them.
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

## 11. Second review (2026-10-09) and what changed

1. Void vs. broadcast race: void now takes the settlement lock in the journal's order (beneficiary advisory lock, settlement,
   commission) before reading attempts; `payout_in_flight` once `broadcast_pending` is committed. Tested with a
   transaction holding the settlement lock while writing `broadcast_pending`: the void waits and then refuses.
2. Read-only replica with `AFFILIATE_SETTLE=1`: one authorization predicate (`settle && writes`) feeds the journal, resume,
   release, withdrawal and retry. Tested with an existing signed attempt: nothing mined, attempt suspended, resume 0.
3. Receipt scope: resolved through receipt → commission/withdrawal → beneficiary → merchant. Tested with two merchants
   sharing a reference: the other merchant's receipt is 404 on both the merchant route and the public route.
4. Receipt destination: the signed payload carries `recipient_sha256` instead of `to`; the public route returns the
   envelope as signed. Tested for an own-wallet commission and a wallet withdrawal (no address anywhere, signature verifies).
5. Batch identity: amount, affiliate, kind, order reference and creation date compared before any effect;
   `skipped_identity_changed` with the changed fields recorded.
6. Batches above 500 revisions: blocks with immediate rescheduling; tested with block 2 on 5 and 3 revisions, including
   a domain failure at the boundary.
7. Refusals before effects: a refused void leaves settlement, attempts, ledger and commission untouched (asserted).
Also added: durable batch rejections (`affiliate_commission_rejections`), exclusive locks at the start of the down
migration, `retry-payout` for a failed settlement (section 6) and the producer's public vectors reproduced in the test
suite. Core suite: 279 tests.

## 12. Third review, before release (2026-10-09) and what changed

1. Lock order: the commission → settlement link is read only after the beneficiary's advisory lock (it changes only under
   that lock), then the settlement row, then the commission row; a second settlement is never locked while holding the
   commission (a mismatch is refused with `concurrent_update`, it cannot happen under the lock). Tested with a retried
   payout (S0 → S1) and a transaction holding S1 and the commission in the journal's order: the void waits and decides
   without a deadlock, both when nothing was sent (200, voided) and when an attempt is in flight (409 `payout_in_flight`).
2. Container launcher (`core/scripts/start-all.ts`): the affiliate flags, quote source, public merchant, streams and the
   batch keys/tokens (`AFFILIATE_KEY_*`, `AFFILIATE_TOKEN_*`, explicit patterns) now reach the core process; treasury key,
   issuer key, seed and any name outside the allowlist never do. Tested through `corePassthroughEnv` into `batchConfig`
   and `streamMap`.
3. A commission released while no destination existed (no wallet, no pool) gets exactly one payout intent later, from
   `release` (idempotent) or `retry-payout`, with the custody fixed at release and no second ledger entry; a wallet
   registered afterwards does not change a `pool` custody. Tested.
4. Every refused batch is durable, including refusals before the handler (415 media type, 413 body too large, keys not
   configured, internal errors): `capture` says whether the body was in hand (`full`, sha and size measured), only
   declared (`declared`, Content-Length) or absent (`none`); no sha of an empty buffer is ever presented as a body.
5. Public page: tables scroll inside their card and the layout never exceeds the viewport (measured at 320, 390, 768 and
   1280 px: `document.scrollWidth == innerWidth`, no element outside the viewport except inside `.tbl-wrap`); the pilot
   card says commissions are converted when they reach PixSettle and counts imported ones separately. Core suite: 282 tests.

## 13. Fourth review, before release (2026-10-09) and what changed

1. C1, audit lost with a large Content-Length: a declared `Content-Length: 3000000000` was refused with 413 but the
   rejection row failed to insert (`bytes` was `integer`) and the error was only logged. `bytes` is now `bigint`; a
   declared value that is not a safe integer is recorded with `bytes = NULL` and the raw header in `detail`; a chunked
   body without Content-Length that exceeds the limit is recorded as `capture = none`. Tested over real HTTP sockets
   (not `app.inject`): 3,000,000,000 declared, 4 MiB + 1 chunked, a full body with its exact sha256, one row per refusal,
   never the body or the token in the row.
2. C2, wrong HTTP status for `text/plain`: Fastify's inherited `text/plain` parser turned a small body into a string and
   `validateBatch` classified it as a size problem (413). The batch scope now removes all inherited content type parsers
   and registers only `application/json`; any other media type (and a missing Content-Type) is 415
   `commission_content_type` before validation, with the rejection recorded; `application/json; charset=utf-8` is
   accepted and processed. A non-Buffer body reaching the handler is also refused with 415 (defence in depth).
3. D1, stale verifier bundle: `web/public/verify.js` is rebuilt from the source with the pinned esbuild and committed; the
   CI gate (`npm run build` then `git diff --exit-code -- public/verify.js`) passes, and the build is reproducible (same
   sha256 on two consecutive builds).
4. D2, on-chain proof of affiliate receipts: see section 5 (receipts). The verifier accepts the two affiliate types,
   matches the log recipient against `recipient_sha256`, shows the nature of the commission or withdrawal instead of a Pix
   step, and never shows the wallet. The public receipt page loads affiliate receipts from
   `/pilot/api/affiliates/receipts/<rct_>` when `/r/<rct_>` has none, renders the commission or withdrawal details without
   the wallet, and the affiliate page links each paid commission and wallet withdrawal to that page. Browser tests (fake
   RPC): both types ok; tampered commitment or tampered log recipient fail; `to` embedded or invalid commitment is
   malformed (fail, no RPC call); RPC down, no receipt yet or incomplete receipt are `unavailable` with the reason;
   settlement and refund receipts unchanged. Web suite: 38 tests. Also: the obsolete `no_payout` code was removed from
   section 6 (the code only raises `no_payout_address`).

## 14. Deploy attempt of v7 and what changed (quote source, v8)

- Observed on Render (attempt 4 of v7): every gate passed except the quote: `api.binance.com` answers HTTP 451 (unavailable
  for legal reasons) from that cloud region, so `/pilot/api/affiliates` returned `rate_now.unavailable` and the automatic
  rollback restored 5686a760. The same was reproduced from a second cloud region on 2026-10-09: `api.binance.com` 451,
  `data-api.binance.vision` 200 with a fresh USDTBRL book.
- E1: the default quote endpoint is now Binance's public market-data service, documented for unauthenticated market data
  (`https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=USDTBRL`): same path, same symbol, same bid/ask contract
  (buy at ask, sell at bid, integer arithmetic, hash over both sides and the time), same cache and stale tolerance. No key,
  no authorization header, no proxy, no host hopping.
- `AFFILIATE_QUOTE_URL` (optional, passed through by the launcher) may point the source at another official Binance host
  with the identical path and symbol (for example `api-gcp.binance.com`); anything else is a configuration error declared at
  boot, never ignored. A quote failure now carries the provider's HTTP status (`rate_now.provider_http_status` in the
  aggregate and the beneficiary view, `httpStatus` in the failure) so a block like 451 is visible as such.
- Tests: all fresh and failed calls go to the public data URL without headers; 451, timeout, invalid JSON and an inverted
  book never produce a quote; the last good quote is reused only within the tolerance and with its explicit age, then the
  current failure is returned with its status; the factory uses the public data URL by default and validates the override.
  An opt-in live test (`AFFILIATE_QUOTE_LIVE=1`) fetches a fresh USDTBRL quote from the public service. The Render proof
  (aggregate 200 with `rate_now.source = binance_usdtbrl`, `age_s` between 0 and 600 on a cold boot) is the deploy smoke.

## 15. Launch quote, capabilities and the production profile (2026-10-10, contract v7)

Context: the merchant moves its whole affiliate program to digital dollars at once. Commissions that were born in BRL
before the switch become dollars at the rate of a REAL conversion made by the merchant on launch day, never presented as
"quoted at Pix time".

- Wire formats, as implemented (and now pinned by a client contract test run against this server): money goes as
  strings of digits (`amount.amount`, `usd_units`); responses carry objects (`usd.units`, `balances.*.units`,
  `net.amount`, `fee.amount`, `rate_now.price4`, `evidence.settlement`). Clients normalize in one place.
- `POST /api/v1/affiliates/commissions` accepts an optional `quote` object. The only mode is `launch`:
  `{ mode: 'launch', rate_num, rate_den, source, at, evidence: { brl_paid_minor, usd_units_received, tx: [hash] } }` where
  `rate_num` = token units that reached the treasury and `rate_den` = BRL cents paid (units per cent, the same format as
  the buy rate). Numbers may be JSON integers or digit strings. Refusals, all before any effect, all 422 with a stable
  code: `launch_quote_disabled` (instance without `AFFILIATE_LAUNCH_QUOTE=1`), `invalid_quote_mode`,
  `invalid_launch_quote` (rate must equal the evidence exactly; source `^[a-z0-9_]{3,40}$`; 1 to 10 transaction hashes of
  64 hex), `launch_quote_future` (more than 5 minutes ahead), `launch_quote_stale` (older than 7 days) and
  `launch_quote_out_of_band` (more than 10% away from the live buy quote).
- Fixing: `usd_units = floor(amount_minor × rate_num / rate_den)`, `fee_bps = 0` (the route cost is already inside a real
  conversion), `quote_mode = 'launch'`, `quote_source = source`, `quote_at = at`, `quote_hash = sha256(JCS(quote))`, and
  the evidence kept in `quote_evidence` (migration 014; a check ties `launch` to the evidence; the down migration refuses
  while any launch commission exists). The merchant view shows `quote.evidence`; the public allow-list does not.
- Idempotency covers the quote: same evidence = same commission (200); a different evidence, or launch versus non-launch
  for the same `source_event_id`, is `409 idempotency_conflict`.
- `GET /api/v1/affiliates/summary` now declares `contract: 'v4'` (API generation) and `capabilities` (`launch_quote` only
  when enabled), shows `rate_now.price4`, and counts `quote_modes.launch`.
- Production profile (`core/src/affiliates/production.ts`, launcher `core/scripts/start-production.ts`): a separate
  instance that serves only the merchant API for affiliates. It refuses to boot on any ambiguity: profile missing,
  `DEMO_MODE=1`, a demo seed, a private key in the core, a public merchant, producer batch keys or streams (one writer per
  merchant), `CHAIN_ID` other than 4217 (42431 only with `PRODUCTION_REHEARSAL=1`), a missing or zero `TREASURY_ADDRESS`, a
  token that is not TIP-20, no `DATABASE_URL`, a simulated quote source (rehearsal only), or `AFFILIATE_SETTLE=1` without the
  local signer and issuer address. The treasury is an address only (custody outside the server); with settlement off the
  chain gateway refuses every signing call, releases record the intent with `affiliate_settle_off`, balances and Pix
  withdrawals work, and `/healthz` shows profile, chain, token, treasury, settle, capabilities and quote source (no
  secrets). With `AFFILIATE_SETTLE=1` the launcher requires `TREASURY_KEY` and `ISSUER_KEY`, refuses a key that does not
  belong to the published `TREASURY_ADDRESS`, starts the signer with `CHAIN_ID` (the signer now picks Tempo mainnet 4217 or
  Moderato by `CHAIN_ID`, mainnet requires an explicit `TOKEN`, faucet only on Moderato) and gives the core only the
  address and the HMAC.
- Merchant provisioning without the key: `core/scripts/affiliates-merchant.ts --name --key-sha256 --pool` stores the
  sha256 of the merchant key (never the key) and the pool (the treasury address), idempotent by id. Since v7.4 (§19) it
  runs only after the first production boot, with the production environment: it never migrates or binds a database.
- Tests: `core/test/affiliates-launch-quote.test.ts` (7) and `core/test/affiliates-production.test.ts` (7, including an
  HTTP end-to-end boot on a fresh database); the merchant client (Odin) runs its own live contract test against this
  profile.

## 16. Adjust before release (2026-10-10, contract v7.1)

Context: two merchant rules lower a commission after it was fixed and before it is released: the per-order cap of the
merchant (recomputed at release) and the "owed amount" rule (a commission voided after its dollars already left, by a Pix
withdrawal or an on-chain payout, is never charged to the beneficiary's wallet; the merchant keeps an owed amount and the
NEXT commissions pay it down before they are credited).

- `POST /api/v1/affiliates/commissions/:id/adjust` with `{ amount, reason_code, occurred_at }`. Only `pending`; only
  lowers (`409 adjust_increase_refused`); `409 commission_not_pending` otherwise; zero or negative is `invalid_amount`
  (to zero a commission, void it). Repeating the same amount is 200 with no effect (idempotent by value).
- The dollar amount is recomputed with the SAME formula and inputs as the fixing (`fixUsdUnits` with the commission's own
  `fee_bps`, `rate_num` and `rate_den`, rounding down), so a client can predict it exactly. The difference is written to the
  ledger as an `adjustment` entry (non-positive units: zero when rounding keeps the same dollar amount; `op_key
  adjust:<id>:<amount>`) and the transition records from/to, units, delta, reason and time. A new amount whose dollars
  would round to zero units is `422 usd_below_one_unit` (v7.2), and an invalid `occurred_at` is `422 invalid_occurred_at`
  before any transaction (v7.2, §17).
- `GET /api/v1/affiliates/summary` and `/healthz` declare `adjust` in `capabilities` (always on with this version).
- Owed-amount offsets on the client side use `reason_code: debt_offset`: a whole commission pays the owed amount by a
  `void` with that reason (never credited), part of it by an `adjust` to the largest amount whose dollars fit in what is
  left. The owed amount itself, the withdrawal block and the 90-day write-off live in the merchant (Odin), which owns the
  rule; this service keeps the dollar ledger exact.
- Tests: `core/test/affiliates-adjust.test.ts` (2) plus the capability expectations in the launch-quote and production
  tests; the Odin client covers the offsets end to end against this server in its live contract test.

## 17. Review fixes before production (2026-10-10, contract v7.2)

Review X-1205 of v7/v7.1 did not approve production: two P1 and two P2 findings plus a rounding limit. All five are fixed,
each with a test that fails on v7.1 (negative control) and passes now.

- F1 (P1), create stays idempotent after an adjust. Migration 015 adds `created_amount_minor`: the amount the commission
  was CREATED with, written once and never changed (a check keeps `0 < amount_minor <= created_amount_minor`). Existing
  rows are backfilled from the creation transition (its JSON carries `amount_minor`), falling back to the current amount;
  the down migration refuses while any commission is adjusted. Create idempotency compares the request with the ORIGINAL
  amount (plus beneficiary, kind, order, time and launch evidence, as before): repeating the original create after one or
  more adjusts is `200` with the same id, the adjusted amount and no new ledger row or transition; a create with the
  adjusted value, or any other value, is `409 idempotency_conflict` (an adjust never turns into a new creation). The same
  holds for launch commissions (same evidence repeats; another value, or no evidence, is 409). Producer batch revisions
  compare with the original amount too, so an API adjust is not reported as `affiliate_amount_changed`. The merchant view
  adds `original_amount` (same shape as `amount`); the public allow-list is unchanged.
- F2 (P1), rehearsal and simulated quotes never settle. `assertNoForbiddenProductionFlags` (shared by the core and the
  launcher) refuses `PRODUCTION_REHEARSAL=1` with `AFFILIATE_SETTLE=1` (`rehearsal_settle_forbidden`, any chain) and a
  simulated quote source with `AFFILIATE_SETTLE=1` (`simulated_quote_settle_forbidden`), even with a valid signer and
  issuer. The core checks it before opening the database (no migration runs on refusal). Rehearsal with settlement off
  keeps working on 4217 and 42431.
- F3 (P2), the launcher validates the original environment. Before filtering what it passes to the core, the launcher
  runs the same forbidden-flag check on its OWN environment (`DEMO_MODE`, demo seed, public merchant, producer batch keys,
  tokens and streams, rehearsal or simulated quote with settlement), then validates the exact environment the core will
  receive with `productionConfigFromEnv` before returning the plan, so nothing is spawned (neither the signer with the key
  nor the core) on a refused configuration. Refusals carry the same codes as the core.
- F4 (P2), invalid dates are 422. `adjust`, `release` and `void` validate `occurred_at` before any transaction, including
  their no-op paths (same amount, already released, already voided): `422 invalid_occurred_at`, nothing changes. Absent,
  `null` or empty keeps the server time; any other non-string value (number, object, boolean) is invalid.
- Rounding limit: a conversion that would round to zero token units (only reachable with an extreme rate) is
  `422 usd_below_one_unit` in create and adjust, never a generic 500 and never a zero-dollar commission.
- Tests: `core/test/affiliates-adjust.test.ts` (9: original replay after adjust, launch replay, fixed orders, an 8-round
  race of create replays, adjust and release with ledger and settlement invariants, migration backfill and refusing down,
  invalid dates on every path, rounding limit), `core/test/affiliates-production.test.ts` (11: the review counterexample in
  the core and in the launcher, boot refused before any table exists, every forbidden flag through the launcher plan, and
  the real launcher process exiting with the code before spawning anything), and the rollback order in
  `core/test/affiliates.test.ts`.
- Limits that stay open (not changed here): launch evidence (transaction hashes and amounts) is declared by the merchant;
  this service checks shape, ratio, time and band, not the chain receipt (the merchant checks arrival on Tempo before
  sending it). A rehearsal pointed at the production database would leave simulated-rate commissions there; binding the
  database to one profile (mode, chain, treasury) at boot is proposed as a release gate, not implemented in v7.2 (done in
  v7.3, §18).

## 18. Database bound to the instance profile (2026-10-10, contract v7.3, after reviews X-1211 and X-1212)

Closes the open limit of §17: a rehearsal (simulated quote) must never write into the production database, and the
production instance must never serve from a rehearsal database, another chain's, token's or treasury's.

- Profile: migration 016 adds `instance_profile`, one row (`id = 1`): `mode` (`production` or `rehearsal`), `chain_id`,
  `token`, `treasury` (lowercase hex), `quote_source` (`binance_usdtbrl` or `simulated`; production only with
  `binance_usdtbrl`, also as a table check), `adopted` and `claimed_at`. A trigger makes the row immutable (no UPDATE, no
  DELETE): changing the binding is a manual, recorded database operation, never automatic. The down migration refuses
  while the row exists.
- Boot order (`startAffiliatesProduction`), all under one session advisory lock so two boots never interleave: (1) only
  the identity (the 016 SQL, idempotent) on a new database, no business migration yet; (2) bind under a table lock: a
  stored profile is compared field by field and any difference is `database_profile_mismatch`; without a profile, a
  database with demo rows (`orders`, `pix_charges`, `pilot_charges`, `attested_events`) is `database_has_demo_data` and a
  database with financial rows (`affiliate_commissions`, `affiliate_ledger`, `affiliate_withdrawals`,
  `affiliate_receipts`, `settlements`) is `database_profile_missing_with_data` (never adopted silently); a clean database
  is bound; (3) only then the business migrations, the server, the worker. On any refusal the pool is closed and nothing
  is served or migrated.
- Launcher: before spawning ANY child (the signer with the key, or the core), it binds or checks the database with the
  same function under the same lock (`preflightDatabase`); the core checks again at its own boot. The row refuses UPDATE
  and DELETE (v7.4 adds TRUNCATE), so the official flow cannot change the binding between the two checks; what a database
  owner or superuser can still do is listed in §19.
- Legacy adoption (`core/scripts/affiliates-adopt-profile.ts`) existed in v7.3 and was REMOVED in v7.4 (§19): legacy data
  does not record what would prove its origin, so it is never adopted.
- F1 limits closed (X-1211): migration 017 recovers an original amount that 015 could not find (first recorded adjust's
  `from_minor`, the value before any reduction; an audit row counts the recoveries) and adds a trigger that refuses any
  UPDATE of `created_amount_minor` (only the creating INSERT writes it; no code path updates it). The race test now runs
  until both orders were observed (adjust before and after release) and counts every payout intent directly.
- `/healthz` shows `database_profile` (`mode`, `quote_source`, `adopted`, `claimed_at`).
- Tests: `core/test/affiliates-instance-profile.test.ts` (9: same reboot, rehearsal and production never cross, quote policy
  in the profile, other treasury/chain/token, conflicting full boots at the same time with each migration applied once,
  legacy data without orders refused and the explicit adoption validated and audited, mismatch with a pending business
  migration refused before migrating, demo data, immutable row and refusing down, the real launcher refused with zero
  children with and without the signer and no effect on the database, and the adoption command arguments), plus 2 F1 tests
  in `core/test/affiliates-adjust.test.ts` (database lock on the original, 017 recovery with audit).

## 19. No legacy adoption, read-only refusals, write guard and key after the database (2026-10-11, contract v7.4, review X-1222)

Answers the four static reviews of v7.3 b8cc379 (database, boot, F1, Relay). Database, boot and F1 items are below; the
Relay evidence is a separate package.

- Legacy is never adopted (BANCO P1/P2). A pre-v7.3 row does not record the instance mode (production or rehearsal), the
  chain and token of a pending obligation, or the treasury; a ledger, withdrawal or receipt row has even less. There is
  no data from which to prove that legacy obligations belong to a profile, so v7.4 removes the adoption command and
  function. A database without a profile is bound only when EMPTY: any row in any table of the public schema (except
  the migration register and the audit rows written by migrations) refuses the boot with
  `database_profile_missing_with_data` (or `database_has_demo_data` for tables outside the affiliate rail; v7.3 only
  counted five financial tables, so merchants, beneficiaries, policies, quote locks, transitions and producer batches now
  count too). Production and rehearsal start on a new database; the Hub re-sends commissions through the API (idempotent
  by `source_event_id`), so every obligation is quoted and recorded under the bound profile.
- Every refusal is decided by reading only (BOOT K2). `identityState` reads the catalog: no identity, current identity,
  the v7.3 b8cc379 identity (to upgrade), the first v7.3 table from 8ec4b9d without `quote_source`/`adopted`
  (`database_profile_schema_outdated`; that version was never applied to a database in use and there is no automatic
  upgrade: use a new database), or a protection removed or disabled (`database_profile_guard_missing`). Then the profile
  row and the row counts are read. A refused boot writes nothing: no identity SQL, no `CREATE OR REPLACE`, no trigger, no
  migration. Writes happen only (a) when an empty database is bound, in one transaction that creates the identity, locks
  every table against writers (`SHARE ROW EXCLUSIVE`), counts again, inserts the profile and installs the write guard,
  or (b) when a database already bound to THIS profile gets the v7.4 identity. A same-profile reboot writes nothing either.
- Identity file: `core/migrations/identity/instance_profile.sql` (not a migration; migration 016 stays byte-identical to
  b8cc379). It adds a statement trigger refusing TRUNCATE of `instance_profile` (BOOT K5), the profile fingerprint
  (sha256 of `mode|chain|token|treasury|quote`), the write guard and its installer.
- Write guard (BANCO P2, legacy writers). On a bound database, every table of the public schema except `instance_profile`
  refuses INSERT, UPDATE, DELETE and TRUNCATE (statement trigger, `legacy_writer_refused`, SQLSTATE 42501) unless the
  session declared the profile: `pixsettle.profile` must equal the stored fingerprint. The v7.4 runtime, launcher and
  merchant tool open every connection with `-c pixsettle.profile=<fingerprint>`; v7.2 or older code, a version rollback
  or a loose tool does not, and is refused. Each migration installs the guard on the tables it creates in the same
  transaction, and the boot installs it on any table still without it. An old writer that already has a transaction
  open when an empty database is being bound makes the bind wait and then refuse (it sees the row); one that arrives
  after the count waits on the table locks and is refused by the guard once the profile commits. Reads are never blocked.
  This is not access control: the fingerprint comes from public values.
- Limits stated without absolute claims (BOOT K5): the profile row refuses UPDATE, DELETE and TRUNCATE and the guard
  refuses undeclared sessions, but the database owner or a superuser can still drop the table, disable a trigger or
  declare the fingerprint by hand. Those are manual operations outside the runtime and must be recorded; the runtime
  never performs any of them, and a boot that finds a disabled profile trigger or guard refuses to start. The boot lock is
  cooperative (it serializes the launcher, the core and the tools, not foreign clients; the guard covers those). On a
  brand-new database the profile is stored before any business table exists, and every table (the migration register
  included) is created in the same transaction that installs its guard, so no table is ever visible unguarded on a bound
  database.
- Key only after the database (BOOT K1). The launcher has three steps: `publicLaunchPlan` (forbidden flags on the
  original environment, the public core variables, the configuration validated with placeholders for what only the
  credential step knows, and the profile) never reads `TREASURY_KEY` or `ISSUER_KEY`, not even their presence;
  `preflightDatabase` checks or binds the database; only then `credentialLaunchPlan` reads and derives the keys (key
  without settlement, missing keys, invalid key without echoing it `signer_key_invalid`, treasury key not matching the
  bound treasury, and new: `issuer_key_mismatch` when `ISSUER_ADDRESS` is given and is not the issuer key's address).
  A database of another profile refuses with `database_profile_mismatch` even with an invalid key in the environment.
- Migrations: each attempt adds one to the sequence `schema_migration_attempts` before running (sequences are not
  transactional, so a failed or rolled-back attempt still counts); attempts equal to the number of migrations proves no
  boot repeated one (BOOT K4). `src/migrate.ts` run directly refuses a bound database (`database_bound`).
- Merchant tool: never migrates and never binds; requires the database bound to the profile of its environment (public
  variables only), with the current identity and no pending migration (`database_not_ready`), and writes declaring the
  profile.
- F1: no adoption path remains, so no legacy commission with an unprovable original can enter a bound database; a
  commission in a bound database is always created with its creation transition in the same transaction. The race test
  is deterministic: the test holds the beneficiary advisory lock and the commission row, queues A then B (checked in
  `pg_locks`), releases, and runs adjust-then-release and release-then-adjust twice each, with create replays while both
  wait; the completion order, the stored transition order and the order counters are asserted.
- Tests: `core/test/affiliates-instance-profile.test.ts` (19): same reboot, rehearsal and production never cross, other
  treasury/chain/token, mismatch with a pending migration refused with the full snapshot unchanged, demo data, eleven
  legacy scenarios (Binance commission without settlement, simulated commission, ledger only, withdrawal only, receipt
  only, settlement of another chain, token or treasury, merchant only, beneficiary wallet only, transitions only) refused
  by production and rehearsal with the full snapshot unchanged, a v7.2-schema database (up to 015, no profile table)
  refused without creating anything, no adoption export or script, the 8ec4b9d table refused with and without a row,
  mismatch on the current and on the b8cc379 identity writing nothing (and the right profile upgrading it), disabled
  protection refusing, the row refusing UPDATE/DELETE/TRUNCATE, the write guard on every table, both old-writer races
  with `pg_locks` barriers, two conflicting full boots in BOTH orders forced through the lock queue (attempts equal to
  migrations, loser leaves the snapshot identical), the key read only after the database (watched environment), the
  real launcher and core refused with a process census (`core/test/fixtures/process-audit.mjs`: no child, no listener,
  nothing alive at exit) plus positive controls, and the merchant tool order. `core/test/affiliates-adjust.test.ts`: the
  barrier race. The full snapshot covers every table (count and md5 of all rows), every sequence value and the catalog
  rows with their `xmin` (classes, columns, functions with body, triggers with state, constraints, indexes).


## 20. Bound databases accepted only intact; sealed fingerprint (2026-10-11, contract v7.5, review X-1277)

Answers the review of v7.4 4b97a33 (three findings and one hypothesis). Principle: a database that already has a profile
row boots only with the current identity, complete and intact. Anything else is refused by reading only, and the boot never
upgrades or repairs a bound database (repair is a manual, recorded operation; production starts on a new database anyway).

- V74-B1, adopted profile. A row with `adopted = true` (written by the adoption that b8cc379 offered and v7.4 removed) is
  refused with `database_profile_adopted`, with the b8cc379 identity and with the current one, and the merchant tool refuses
  it too: an equal profile does not prove where the data already stored came from. Native rows (`adopted = false`) are the
  control and boot normally.
- V74-B3, upgrade window. The v7.4 boot upgraded the identity of a database bound by b8cc379 (same profile) and only later,
  in the migrations, installed the write guard on the tables that already existed. v7.5 removes that path: a bound database
  whose identity is from an earlier version or incomplete (state `upgrade`, now including a v7.4 identity without the seal
  or with a piece removed) is refused with `database_identity_not_current` by the launcher, the core and the merchant tool
  (`database_not_ready`), and nothing is written, so there is no window. The identity file runs only inside the transaction
  that binds a new, empty database.
- Removed protection versus upgrade. On a bound database the boot also requires, by reading: the sealed fingerprint equal to
  the row's fingerprint, and the write guard present and enabled (O or A) on every table of the public schema except
  `instance_profile`. A missing seal, a different seal or a table without its guard refuses with
  `database_profile_guard_missing`; the end-of-boot installer no longer has anything to re-arm on existing tables.
- V74-K5, ENABLE REPLICA. Triggers count as protection only in states O (origin/local) and A (always). R fires only under
  `session_replication_role = replica` and D is disabled: both refuse the boot (`database_profile_guard_missing`, with the
  table and the state in the message) for the profile's immutable and no-truncate triggers and for any write guard, before
  any key, child or listener (process census in the tests). Nothing is re-enabled by the boot. When an empty database is
  bound, the installer refuses an existing trigger with the guard's name in R or D instead of skipping it, and the bind
  transaction checks again that every table leaves with its guard in O or A; otherwise the whole bind rolls back.
- V74-H2, old snapshot (reproduced, then closed). On v7.4 a REPEATABLE READ session whose snapshot was taken before the bind
  could INSERT and COMMIT without declaring the profile, both on a database with no tables and on an existing empty schema:
  the guard read the profile row through the session's old snapshot, saw nothing and let the write through. v7.5 seals the
  fingerprint in the catalog in the same transaction that inserts the row (`instance_profile_seal()` replaces
  `instance_profile_sealed_fingerprint()` by a function returning the constant), and the guard compares the declared
  `pixsettle.profile` with the sealed constant. Catalog lookups see the committed function, not the old snapshot, so the
  stale session is refused and nothing persists. The guard fails closed when there is no seal, the installer refuses to
  install a guard before the seal, the seal refuses a database without a row or a different value, and running the identity
  file again never unseals.
- Tests: `core/test/affiliates-instance-profile.test.ts`, block "v7.5 (X-1277)": B1 in both identities and through the
  merchant tool; B3 through the core, the launcher and the tool, with the catalog and the data unchanged and no guard
  installed; removed protection (no seal, different seal, null seal, table without guard) refused with the database
  unchanged, and a declared writer refused when the seal is null; K5 with three R fixtures and D on the no-truncate
  trigger, core and launcher (census: no child, no listener, nothing alive at exit) and A accepted as the control; a
  trigger planted with the guard's name in R on an unbound v7.2-schema database makes the bind roll back with the database
  unchanged; H2 in both variants; seal ordering and idempotency. The v7.4 test "K2" now expects the right profile to be refused on a b8cc379
  identity as well.
