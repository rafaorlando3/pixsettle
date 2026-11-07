# Try to break PixSettle | isolated synthetic lab

Post-submission experiment, independent of the judged release. No bank/provider/chain calls, keys, real payments or customer data.

Python 3.12 standard library only. Run `python3 -m unittest -v test_challenge` then `CHALLENGE_SHA=$(git rev-parse HEAD) python3 server.py` in this directory on the authorized VPS. Listens only at 127.0.0.1:18766. No worker, cron, shared DB or existing service is modified.

Five adverse scenarios and a positive control, plus editable synthetic events. POST /api/evaluate accepts exactly {events:[...]} with 1–6 strict events. Event keys: event_id (DEMO-EVT-1..9999), kind (payment/refund), amount_minor (integer 1..100000000), currency (BRL), reference (PS-DEMO-000..999 or empty), occurred_at (2030-01-01T12:00:00Z..12:59:59Z), payment_id (empty or DEMO-EVT-ID). The order fixture is PS-DEMO-001, 10000 BRL cents, expiration 12:10:00Z exclusive. Requests replay from an empty order; reset starts a new history, no global payment state exists.

POST /api/verify accepts the exported envelope. It recalculates the receipt and ALL decisions with this source version, rather than trusting a supplied hash or claimed outcome. SHA-256 is integrity/reproducibility, not authentication, third-party witness, blockchain anchoring, bank evidence or correctness proof. GET /api/receipts/HASH returns a bounded public synthetic copy for up to 15 minutes; export JSON for later reproduction. Restart clears the cache. GET /api/version reports the exact source SHA, fixture, limits and disclosures. GET /source/engine.py exposes the readable policy.

Safety: 16KiB body, strict UTF-8 JSON, duplicate keys and non-finite numbers refused, no HTML interpolation of inputs, CSP, no CORS, server-side 30 requests/min/source and 180 total, max 24 active handlers, 5s socket timeout, max 256 receipts and 512 ephemeral HMAC-source buckets. No cookies, analytics or application access log; network hosting may process transport metadata. Public proxy must preserve applicable limits or explicitly account for shared origin. A retained result is NOT an automatic financial release.

The naive baseline deliberately counts every payment notification as a release. This is an illustrative failure model, not a statement about Held or all other systems. Refund records an exception and retains prior history; it cannot reverse external money.

Known boundaries: single Python process and in-memory limits (reset on restart), IPv4 loopback origin. Proxy and public deployment remain separate review steps. No public Colosseum post is authorized by this code. Keep main, demos, GitLab, CI, videos and judged submission untouched.

Review revision: summary distinguishes last_event_decision from final order_status; a repeated refund retains refund_exception and uses a neutral duplicate message. The array is arrival order; event timestamps do not reorder previously processed facts. Refunds may happen after payment expiration. The form exposes identical replay and changed-value identity conflict.

For a public prefix route, TRUST_LOCAL_PROXY=1 accepts exactly one valid X-Real-IP only from a loopback peer. The local trusted proxy MUST replace that header with its direct remote IP; never copy caller-supplied forwarding headers. Without that flag, forwarding headers are ignored. Direct-origin port stays loopback; code applies both per-origin and global limits, including static assets. Do not expose before reviewed proxy configuration.

Claude Code review revision: requests have a total 8s deadline enforced even while headers/body arrive slowly, in addition to 5s socket idle timeout; metadata exposes the deadline. Invalid/Unicode/oversized Content-Length is refused before integer conversion. Server header omits Python version. Query strings on GET are ignored and /index.html aliases /. Invalid embedded receipt events yield verified:false. Internal failures increment a nonidentifying in-memory counter without request logging. HEAD and closed connections are handled. Static paths/API URLs support an isolated reverse-proxy prefix.
