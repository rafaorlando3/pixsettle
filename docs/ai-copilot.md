# Exception copilot

Every exception PixSettle finds (a second charge for the same order, a payment under the amount, a payment after the window, a second payment, a refund request, a MED claim, a divergent manual Pix, a failed or reversed withdrawal) gets a **verdict**: an action from a closed list, a confidence, a rationale, and the evidence lines it used. The verdict is immutable, hashed, and shown next to the exception on `/pilot`.

The historical shadow release uses a separate typed projection and append-only advisory review ledger. Its public reads never run the financial policy or write a decision. A model-assisted operator review remains advisory and does not count as a human authorization or resolved financial exception. The action guard below describes the core's policy; release measurements report the shadow statuses actually observed.

The copilot exists to decide, not to chat. Four tests, applied to every piece of it:

1. **It decides with evidence.** The verdict cites evidence ids (`e1`, `e2`...) that PixSettle itself assembled from the ledger; a verdict that cites an id that does not exist is rejected.
2. **It is measured against the same task without a model.** Deterministic rules run first and close everything they can with confidence 0.9 or more. The current historical replay reports only decisions measured from its approved shadow projection. A recorded verdict does not settle funds or prove bank settlement. Legacy local counts are not release metrics.
3. **It has a guard.** Only *reversible* actions can be applied without a human (`hold_request_balance`, `close_benign_retry`, `close_expired`, `close_superseded`, `close_reversed`, `flag_review`), and only with confidence of at least 0.85 and no disagreement between rules and model. Anything that moves money (`refund_*`, `credit_customer`, `accept_as_paid`, `accept_late`, `approve_refund`, `contest_with_evidence`...) always waits for the operator, whatever the model says. If the model is off, fails, returns something that is not JSON, or an action outside the list, the exception goes to the human with that reason on screen; nothing is retried silently.
4. **It is visible.** The exception queue, the verdict, the confidence meter and the reason a case is waiting are the first thing on the pilot page.

## Actions by exception kind

| Kind | Actions (reversible in bold) |
| --- | --- |
| `duplicate_charge` | **close_benign_retry**, **flag_review**, escalate |
| `duplicate_payment` | refund_duplicate, credit_customer, escalate |
| `amount_mismatch` | **hold_request_balance**, refund_partial, refund_excess, accept_as_paid, escalate |
| `late_payment` | refund_late, accept_late, escalate |
| `expired_unpaid` | **close_expired**, **flag_review** |
| `charge_failed` | **close_superseded**, **close_expired**, **flag_review** |
| `refund_requested` | approve_refund, reject_refund, escalate |
| `med_reported` | contest_with_evidence, accept_refund, escalate |
| `manual_divergent` | **hold_request_balance**, refund_partial, accept_as_paid, escalate |
| `withdrawal_failed` | **close_reversed**, retry_withdrawal, **flag_review**, escalate |
| `withdrawal_reversal` | **close_reversed**, **flag_review**, escalate |

## Rules (no model)

`core/src/copilot/rules.ts`. Examples: several charges for one order with exactly one paid and the rest expired, failed or cancelled is a checkout retry (`close_benign_retry`, 0.97); a charge that expired with no payment on the order closes as unpaid (`close_expired`, 0.95); a failed charge superseded by a paid one closes (`close_superseded`, 0.96); a withdrawal reversal returns the money to the balance (`close_reversed`, 0.9); a shortfall of up to R$ 1,00 holds the order and asks the payer for the balance (`hold_request_balance`, 0.9). Everything else is **residue** and goes to the model with the reason recorded.

## Model

`core/src/copilot/model.ts`. One interface, two HTTP providers (Anthropic Messages, OpenAI-compatible chat completions), a **replay** store and a recording wrapper. The prompt (`core/src/copilot/judge.ts`) gives the model the exception kind, the allowed actions, which of them are reversible, the structured facts (amounts in cents, UTC timestamps, no personal data: the facts are the same pseudonymized facts the pilot stores) and the numbered evidence, and demands exactly one JSON object. The answer is validated strictly (`validateVerdict`): closed fields, action in the list, numeric confidence in [0, 1] without rounding or coercion, a required boolean requires_human, rationale 8 to 800 characters, and known non-empty evidence refs. An irreversible action is forced to `requires_human: true`.

| `COPILOT_MODE` | Behaviour |
| --- | --- |
| `off` (default) | no model; residue waits for the human with "model off" on screen |
| `live` | calls the provider; `COPILOT_PROVIDER` (`anthropic` or `openai`), `COPILOT_MODEL`, `COPILOT_API_KEY`, `COPILOT_BASE_URL` |
| `live_record` | same, and records only validated answers after the locked facts/evidence check, keyed by the exact input hash |
| `replay` | reads only `copilot_replay`; an unseen input is `replay_miss`. Public replay displays stored decisions without executing model jobs, policies or operator decisions |

A model failure is terminal on its first attempt: a controlled reason is recorded and the exception goes to the human, with no automatic paid retry. After a response, the locked facts and evidence must still match the exact input hash; changed context goes to the human without a stale verdict or replay record. Public responses use a closed projection and controlled text, including historical rows.

`COPILOT_BUDGET_CALLS_PER_DAY` limits calls, not dollars. Monetary reservation and the shared provider cap must be checked separately before a private sequential live stage. `PUBLIC_REPLAY_READ_ONLY=1` blocks pilot/model writes and jobs for attested orders while preserving the isolated simulated demo; `PILOT_V1_DISABLED=1` also disables legacy pilot ingestion independently of model mode. These flags and the configured budget are passed through the container launcher.

## Audit

`copilot_verdicts` is append-only (database trigger). Each row carries `input_hash` (SHA-256 of the canonical input), `verdict_hash` (SHA-256 of the canonical verdict), engine (`rules`, `model`, `replay`, `operator`), model name, latency and the provider's usage when reported. The operator's decision is a verdict too, with `agreed_with_copilot` recorded on the exception, which is what the agreement rate on the page is computed from. Every status change of an exception is a `state_transitions` row.

## Release measurements

Read the deployed `/pilot/api/summary` and save it with the exact Render deploy id, commit, database revision and source export hash. Record observed payments separately from matched orders; an exact monetary match is not a bank settlement. Count resolved advisory cases from their actual status and explain their scope. The old v1 local results (493 exceptions, 479 resolved statuses and 469 automatic dispositions) describe a different pipeline and must not be reused as current shadow results.

## Private USD reservation

Live/live_record require `COPILOT_BUDGET_MICROS`. `COPILOT_CALL_RESERVE_MICROS` defaults to 20000 and `COPILOT_MAX_CALLS` to 200; cap above US$20 is refused. The daily calls setting is an additional admission rule, not monetary evidence. Replay/off do not open the spend ledger.

Migration 010 stores an immutable policy and `copilot_spend`, unique by model/input hash. A reservation commits before inference. HTTP admission uses a DB session lock; another in-flight call is refused before network activity. A crash, failed call, missing cost, settlement-write failure or cost above its reservation stops the envelope. Failed/unknown rows retain the reservation; reported low cost never releases it. Restart cannot enlarge the existing DB policy or automatically resend an input. The first model error remains terminal at the human fallback.

Budgeted input is limited to 16 KiB UTF8 and the provider output to 700 tokens. The reserve must cover the configured route price; this class alone does not prove the external provider price. A separate private executor must verify current provider pricing and that each reservation covers the configured route, then enforce its authorized call and dollar envelope and any shared provider cap before every call. These checks describe the admission contract; they do not attest that a live stage has run. A deliberate new stage requires a separately marked private/quarantine DB and a new ledger scope.
