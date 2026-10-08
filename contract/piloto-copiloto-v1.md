# Pilot contract: attested events and exception advisory

This document supplements the historical core design in [CONTRATO.md](CONTRATO.md). The public pilot uses pseudonymized, merchant-attested historical events in read-only shadow mode. Recorded advisory verdicts do not prove independent verification of Pix receipt and do not authorize financial execution.

## 1. Purpose and safeguards

1. An advisory verdict must cite evidence and suggest an action, rather than simply restating the screen.
2. Compare the model against deterministic rules on the same task. Report measured results with their source and scope; do not substitute a historical test count for current CI.
3. Enforce confidence thresholds, human confirmation for irreversible actions, and visible fallback reasons. No silent failure.
4. Make the advisory behavior and demo limits clear in the walkthrough.

## 2. The `attested` provider

- `orders.provider_env = 'attested'` and `pix_charges.provider = 'attested'`: the merchant operator attests to the Pix event in a signed batch (HMAC-SHA256 over the raw body, `x-pilot-signature`). This is not a query to an independent payment provider.
- Periodic sweeping, active expiry and refund execution do not touch attested charges (`flows/sweep.ts`, `flows/refunds.ts`). Refunds wait for an attested outcome (`order.refund.completed` or `.rejected`).
- Application uses the same observation path as other providers: `applyObservation` -> paid -> settlement intent -> send journal -> receipt. With `PILOT_SETTLE=0`, the order stays `paid` and records `settlement_skipped` with a reason. Keep this boundary for the public shadow pilot.
- The pilot FX quote is simulated and scaled down (`pilotRateNum/Den`, default one unit per cent) to fit testnet funding; `quotes.source` remains `simulated`.
- The order's payment window uses the latest charge expiry. A charge without an expiry uses a 30-day horizon. The operator's `late` attestation (0/1) takes precedence over the estimate, with an `order_window` transition recorded.
- Multiple charges per order live in `pilot_charges`. `pix_charges` keeps the paid charge, or the latest charge, for receipts and refunds.
- A merchant-attested MED case uses `refund_cases.refund_type = 'med_attested'` and remains `requested` until its outcome is attested. It blocks new settlement like any other open refund case.

## 3. Ingestion guard

`core/src/pilot/guard.ts` accepts a closed list of keys. Personal-data-like keys (`name`, `payer`, `document`, `email`, `phone`, `address`, `product`, `key`, `token`, etc.) are rejected. Values containing an email, a CPF or ten or more digits are rejected. IDs use letters only (`o_`, `i_`, `w_` followed by 20 letters), amounts use `d+.dd`, and `ts` is ISO UTC. A rejected row returns a reason and is not stored. Deduplication uses SHA-256 of canonical JSON (RFC 8785).

## 4. Exceptions

The `exceptions` table stores one case per fingerprint (`order:type:key`) with `severity`, `status` (`open`, `auto_applied`, `awaiting_human`, `resolved`, `dismissed`), `copilot_state` (`pending_rules`, `rules_only`, `pending_model`, `model_done`, `model_error`, `model_off`), `evidence` (`[{id, fact}]`), structured non-personal `facts`, a visible `last_error`, and `resolution` (`{action, by, note, at}`). New evidence on an open exception without a human decision triggers another rules assessment.

Types: `duplicate_charge`, `duplicate_payment`, `amount_mismatch`, `late_payment`, `expired_unpaid`, `charge_failed`, `refund_requested`, `med_reported`, `manual_divergent`, `withdrawal_failed`, `withdrawal_reversal`.

## 5. Verdict and policy

- A verdict has `{action, confidence, requires_human, rationale, evidence_refs}`. Actions are restricted by exception type (`copilot/verdict.ts`); validation checks action, range and references against the supplied evidence. Irreversible actions force `requires_human`.
- Automatic application is limited to reversible actions (`close_*`, `hold_request_balance`, `flag_review`) with confidence at least 0.85 and no disagreement between rules and model. Other actions wait for the operator. The public shadow projection does not execute financial actions.
- `copilot_verdicts` is append-only (`append_only` trigger), with `input_hash`, `verdict_hash` (SHA-256 of canonical JSON), `engine` (`rules`, `model`, `replay`, `operator`), latency and usage. Preserve existing records; display-copy changes must not rewrite audit history.
- `COPILOT_MODE` supports `off`, `replay`, `live` and `live_record`. Providers include Anthropic Messages and OpenAI-compatible APIs. The first failure of a `copilot_judge` job becomes `model_error` with a controlled code and visible human fallback, without an automatic paid retry. A response is stored only after strict validation and a facts/evidence CAS under the lock. Changed context receives neither a verdict nor a replay. Replay reads an exact input/model match without jobs, policy or decisions; absence is `replay_miss`. A call budget does not replace the private monetary reservation or provider spending limit.
- An operator decision uses `POST /pilot/api/exceptions/:id/decide`, authenticated by `PILOT_OPERATOR_TOKEN`. It becomes an `operator` verdict and records `agreed_with_copilot` for the page metric. Never place the token value in documentation or public evidence.

## 6. Acceptance scenarios

These scenarios describe the contract to verify against `core/test/pilot.test.ts` and current CI. No test execution or count is asserted by this document.

1. Reject personal data and unknown keys with a reason while accepting valid rows.
2. A repeated batch accepts no new rows, counts duplicates and does not reprocess them.
3. Defer an out-of-order event and apply it when its prerequisite becomes available.
4. In a separately enabled testnet settlement test, an attested paid order produces a `settlement` receipt with the actual test signer. This is distinct from the public shadow pilot.
5. For three charges with one paid, rules close `duplicate_charge` and informational `expired_unpaid` and `charge_failed` cases.
6. A one-cent underpayment produces a hold and reversible `hold_request_balance`; a larger mismatch may require model assessment. Without a model, fall back to the human with a reason.
7. An invalid model response produces `model_error` without a stored verdict. A stored verdict remains immutable.
8. An attested refund avoids a provider call, is confirmed by `completed`, and produces `refund_notice`.
9. Preserve attested MED and late-payment facts and the window behavior of a charge without expiry.
10. Check raw-body signature and content type. Public reads omit internal IDs; operator decisions require authentication.

## 7. Separate work

A verdict hash inside a signed receipt requires a new receipt vector and validation. Merchant wallet-statement receipt links (subject to merchant agreement), authorized incremental merchant exports and model evaluation on the unresolved residue are separate tasks. A display label or API actor change requires an explicit compatibility review and tests; it is not a documentation-only edit. Historical append-only verdicts must remain unchanged.
