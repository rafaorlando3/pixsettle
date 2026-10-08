// Evidence for the running release. The database marker is read from the actual
// connection; model and signer attempts are counted before their HTTP request.
import type { Db } from './db.js'

const counters = { model_attempts: 0, chain_attempts: 0 }
export function recordModelAttempt() { counters.model_attempts++ }
export function recordChainAttempt() { counters.chain_attempts++ }
export function outboundAttempts() { return { ...counters } }

const sha40 = (v: unknown): string | null => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v) ? v : null
const sha64 = (v: unknown): string | null => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : null
const uuid = (v: unknown): string | null => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v) ? v : null

export async function runtimeReport(db: Db, env: Record<string, string | undefined> = process.env) {
  const r = (await db.query(`SELECT database_revision::text, source_sha256, expected_commit_sha
    FROM pilot_release_identity WHERE singleton=true`)).rows[0]
  return {
    commit_sha: sha40(env.RENDER_GIT_COMMIT),
    database_revision: uuid(r?.database_revision),
    source_sha256: sha64(r?.source_sha256),
    expected_commit_sha: sha40(r?.expected_commit_sha),
    counters: outboundAttempts(),
  }
}
