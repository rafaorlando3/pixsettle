import { describe, it, expect } from 'vitest'
import { runtimeReport, recordModelAttempt, recordChainAttempt, outboundAttempts } from '../src/release-runtime.js'
import type { Db } from '../src/db.js'

describe('release runtime evidence', () => {
  it('reads the actual database marker and uses only valid, non-secret identities', async () => {
    const marker = { database_revision: 'aef4d135-bba9-4588-96a3-1ea6995e751a', source_sha256: 'b'.repeat(64), expected_commit_sha: 'c'.repeat(40) }
    const sql: string[] = []
    const db = { query: async (q: string) => { sql.push(q); return { rows: [marker] } } } as unknown as Db
    const r = await runtimeReport(db, { RENDER_GIT_COMMIT: 'a'.repeat(40), COPILOT_API_KEY: 'private-test-secret' })
    expect(r).toMatchObject({ commit_sha: 'a'.repeat(40), ...marker })
    expect(sql).toHaveLength(1)
    expect(sql[0]).toContain('FROM pilot_release_identity')
    expect(JSON.stringify(r)).not.toContain('private-test-secret')
    expect(r.instance_id).toMatch(/^[a-f0-9-]{36}$/)
    expect((await runtimeReport(db, {})).instance_id).toBe(r.instance_id)
    expect(r.started_at).toMatch(/^\d{4}-\d\d-\d\dT/)
  })
  it('does not substitute environment values for a missing database marker', async () => {
    const db = { query: async () => ({ rows: [] }) } as unknown as Db
    const r = await runtimeReport(db, { RENDER_GIT_COMMIT: 'a'.repeat(40), DATABASE_REVISION: 'aef4d135-bba9-4588-96a3-1ea6995e751a' })
    expect(r.database_revision).toBeNull()
    expect(r.expected_commit_sha).toBeNull()
  })
  it('rejects malformed or arbitrary marker fields without echoing them', async () => {
    const db = { query: async () => ({ rows: [{ database_revision: 'user@example.test', source_sha256: 'private', expected_commit_sha: 'private' }] }) } as unknown as Db
    const r = await runtimeReport(db, { RENDER_GIT_COMMIT: 'not-a-commit' })
    expect(r).toMatchObject({ commit_sha: null, database_revision: null, source_sha256: null, expected_commit_sha: null })
    expect(JSON.stringify(r)).not.toContain('user@example')
  })
  it('counts attempts monotonically and returns a copy of the counters', () => {
    const before = outboundAttempts()
    recordModelAttempt(); recordChainAttempt()
    const after = outboundAttempts()
    expect(after.model_attempts).toBe(before.model_attempts + 1)
    expect(after.chain_attempts).toBe(before.chain_attempts + 1)
    after.model_attempts = -1
    expect(outboundAttempts().model_attempts).toBeGreaterThanOrEqual(before.model_attempts + 1)
  })
})
