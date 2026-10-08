# Historical shadow pilot

`/pilot` is a read-only replay of a pseudonymized historical export from a multi-store merchant operation. No paid inference runs and no funds move on this public surface. `/demo` separately simulates the Pix and Tempo testnet flow.

Public reads are `GET /pilot/api/summary`, `GET /pilot/api/exceptions` and `GET /pilot/api/exceptions/:id`. In the public shadow release these reads are projected from `pilot_shadow_*` and approved advisory review records. They do not query or mutate the financial core's orders, charges, outbox, refunds, settlements or receipts.

## Approved input

The source contract is `pixsettle-shadow-feed/1.3`, independently checked against the E1 v1.7 Python validator. Its closed event vocabulary is `order_created`, `pix_received`, `refund`, `med`, `partner_withdrawal`, `wallet_charge` and `order_cancelled`. Amounts are positive integer BRL cents, timestamps are real UTC calendar instants, and references are typed pseudonyms. Origin/store are separate trusted namespaces.

A historical export using the earlier vocabulary needs an explicit projection receipt: original exact SHA256, declared mappings, exclusions, counts and output hashes. Re-signing a legacy file without that provenance does not establish an approved current feed. Names, documents, contacts, addresses, products, credentials and raw provider responses have no place in the public projection.

## Exact-byte private entry

Every input has matching `LOTE-<stem>.jsonl`, `ATESTADO-<stem>.json` and `PRONTO-<stem>.json`. PRONTO is the publication boundary; it binds the original LOTE/ATESTADO names and bytes. The attestation binds origin, store, issuer key, cursor interval, counts and per-type totals with HMAC. HMAC proves an authorized issuer possessed the key; it does not prove bank settlement.

`POST /pilot/v2/batches?store=store_1` requires a Bearer token scoped to the configured origin/store and content type `application/x-pixsettle-shadow-trio`. The binary frame starts with `PIXSETTLE-SHADOW-TRIO/1\n`, then four uint32-BE lengths and their exact byte bodies: metadata JSON with all three filenames, LOTE, ATESTADO and PRONTO. File sizes and names are bounded; the server authenticates before parsing the body. The loader never reserializes or reorders those three files.

An origin/store transaction lock is acquired before reading or writing shadow storage. Events deduplicate by scoped event id and exact line hash. Acceptance, counts, checkpoint and signed receipt commit together with synchronous commit enabled. Contention is a controlled busy result. A conflict rolls back the complete acceptance and saves a signed rejection separately, without advancing its checkpoint.

Receipts bind all three filenames/hashes and the entire trio, plus origin/store/key, accepted/duplicate/rejected counts and checkpoint. Replaying the exact trio returns the same authenticated receipt. Different PRONTO/ATESTADO bytes for an existing LOTE are a binding conflict. An issuer key must also be valid at receipt issuance; a historical signature alone cannot authorize a new receipt after key expiry.

`GET /pilot/v2/batches/:lote_sha256?store=store_1` uses the same token scope. Only `404 shadow_batch_not_found` proves absence. Storage failure or an invalid stored receipt is `503`; neither authorizes an automatic resend. The loader validates HMAC, context and all bindings, uses a process mutex, fsyncs file and directory, records intent before POST and queries the receipt after an uncertain send. A rejected receipt never counts as success.

## Public replay controls

| Variable | Public release |
| --- | --- |
| `COPILOT_MODE` | `replay` |
| `PUBLIC_REPLAY_READ_ONLY` | `1` |
| `PILOT_SHADOW_PUBLIC` | `1` |
| `PILOT_SETTLE` | `0` |
| `PILOT_V1_DISABLED` | `1` |
| `COPILOT_BUDGET_CALLS_PER_DAY` | `0` |
| `COPILOT_BUDGET_MICROS` | `0` |

Legacy POST `/pilot/v1/events` and `/pilot/v1/process` return `409 pilot_v1_disabled`; public operator decisions return `409 replay_readonly`. Shadow requests and rejected writes do not wake the financial worker. No shadow event is converted into a core order, provider request or chain job.

`PILOT_SHADOW_KEYRING_JSON` contains only key metadata (`env`, origin, stores, validity, revoked). Key values live in named private `PILOT_SHADOW_KEY_*` variables. `PILOT_SHADOW_TOKENS_JSON` contains only token environment names and scope; values live in private `PILOT_SHADOW_TOKEN_*` variables. The container passes these secrets only to the core. The signer receives none of them.

## Measured quantities

The independently verified historical source has 9,144 lines and 7,849 canonical event identities. It contains 1,207 order-created records: 1,195 positive amounts and 12 zero amounts, which need an explicit exclusion under the current positive-cent contract. It has 586 observed Pix receipts totaling 42,511,994 cents. Of these, 582 equal their referenced order amount and total 42,231,095 cents; four differ and total 280,899 cents. These are source observations and numerical matches, not deployed statuses or bank settlement.

Source stream codes and metadata are different denominators. Five codes appear in both; two metadata codes have no source events, and one source code has no metadata row. The projection must declare their disposition rather than claim seven active stores or guess the role of the unmatched account.

Final release numbers come from the actual deployed summary, stored in the release evidence with commit, deploy, database revision and source hash. Observed payment value, matched payment value, advisory exceptions and resolved advisory cases remain separate measurements. No legacy local count is copied into the release merely because it appeared in an earlier demo or script.
