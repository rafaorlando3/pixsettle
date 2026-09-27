import { readdirSync, readFileSync } from 'node:fs'
import { createPool, type Db } from './db.js'

export async function migrate(db: Db, dir = new URL('../migrations/', import.meta.url)): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name as string))
  const applied: string[] = []
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(readFileSync(new URL(f, dir), 'utf8'))
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f])
      await client.query('COMMIT')
      applied.push(f)
    } catch (e) {
      await client.query('ROLLBACK')
      throw new Error(`migração ${f} falhou: ${(e as Error).message}`)
    } finally { client.release() }
  }
  return applied
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool()
  migrate(db).then(a => { console.log('aplicadas:', a); return db.end() }).catch(e => { console.error(e.message); process.exit(1) })
}
