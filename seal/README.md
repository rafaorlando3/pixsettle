# @pixsettle/seal — Proof Before Pay

A TypeScript commitment and verifier for structured decision records using `pbp.seal/1`.
This test-only package does not authorize, sign or execute payments.

## Record contract

`commitment = sha256("pbp.seal/1\n" + salt_hex + "\n" + JCS(record))`

Use a fresh 32-byte random salt. The Solana Memo payload format is `pbp1:<commitment>`.
Keep the record and salt private; revealing both lets others recompute the commitment and exposes the record.

Validation covers explicit missing evidence (`null`), tool outputs, forbidden actions, declarative limits,
minor-unit amounts as strings, and valid UTC timestamps. Objects must have own enumerable data fields;
arrays must be dense. Diagnostic paths preserve accepted identifier keys and redact recognized PII
patterns or keys outside the accepted identifier syntax.

## Verification and responsibility

`verifyAgainst` compares the record and salt with caller-supplied Memo and time metadata. It returns
`sealed`, `tampered`, `pending` or `unverifiable`. A matching commitment establishes integrity of the
canonical representation of the record; it does not establish that the underlying facts or decision are correct.

The package does not independently query RPC or verify a transaction's signer, cluster or finality.
Supplied metadata is not an independent on-chain witness. The host application must verify that evidence,
enforce authentication, approval and payment policy, and handle idempotency and recovery.

PII detection is pattern-based and limited to recognized CPF/CNPJ, email, phone and Pix-key patterns.
It does not establish anonymization. The host must minimize and protect data before sealing or revealing it.

## Tests

The suite declares 70 tests covering shared canonicalization/commitment vectors, verification states
and security regressions. Execution results must be reported separately.

Test commands: `npm test`; `npm run typecheck`.
