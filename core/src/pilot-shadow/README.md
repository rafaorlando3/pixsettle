E1 1.3 shadow entry. Node 22 is required for lexical JSON number validation; an older parser fails closed.

validateTrio(input, trusted) preserves the LOTE/ATESTADO/PRONTO bytes, enforces bounded sizes, fixed safe
basenames, all E1 v1.7 checks, PRONTO hashes, issuer HMAC and trusted origin/store/keyring scope.
ValidatedTrio is deep frozen and runtime branded. The DB API rejects structural casts and rechecks
current key scope; line hashes use the exact bytes before each LF, without JSON normalization.

The keyring has only metadata. secrets maps environment variable names to strings in memory.
Do not serialize this context. HMAC proves possession of an authorized issuer key, not settlement.

Migration 008 creates only pilot_shadow_streams/events/batches. Existing core, v1 pilot, provider,
outbox, refund and chain tables are neither read nor written by ingestShadowBatch. A single reserved
connection obtains the origin/store transaction lock before any storage read/write. Contended requests
return busy with no writes. Accepted events, monotonic checkpoint and signed receipt commit together
with synchronous_commit=on. A conflict rolls back all event/checkpoint writes, then persists a rejected
receipt in a separate durable transaction. ShadowEventConflict.receipt carries that signed rejection.
Events and receipts are append only. No processPending/applyObservation/model/provider is called.

A receipt binds origin/store/key_id plus all three filenames and exact SHA256 hashes. The batch PK is
(origin,store,lote_sha256); changing attestation/PRONTO bytes for an already seen LOTE is a binding conflict,
not a replay of a different artifact. Replaying the exact trio returns the same accepted receipt with
accepted=0; an exact rejected replay throws with the same receipt. verifyShadowReceipt is required before
trusting a loader journal. It verifies the precise trio/context, shape, counts, result and HMAC.
Only result=accepted may be considered successful by the HTTP boundary or loader.

Run the unchanged 33 E1 Python tests and harvest every invocation:
  python3 core/scripts/pilot-shadow-differential-harvest.py <verified-e1-directory> <cases.jsonl>
  node --import ./core/node_modules/tsx/dist/loader.mjs core/test/pilot-shadow-differential-run.ts <cases.jsonl>
Extra malformed/calendar/nonfinite vectors:
  python3 core/scripts/pilot-shadow-differential-extra.py <verified-e1-directory> <extra.jsonl>
  node --import ./core/node_modules/tsx/dist/loader.mjs core/test/pilot-shadow-differential-run.ts <extra.jsonl>
The standalone CLI core/scripts/pilot-shadow-validate.ts matches E1 exit codes 0/1/2 and fixed messages;
it validates only, without ingestion. Production discovery/HTTP/loader belongs to the separate boundary.
