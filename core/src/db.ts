// Acesso ao PostgreSQL. Regra (X-0003): cada transação usa UMA conexão reservada do BEGIN ao
// COMMIT/ROLLBACK, incluindo travas e escrita na outbox. Nunca espalhar passos em pool.query.
import pg from 'pg'
import { createHash } from 'node:crypto'

export type Db = pg.Pool
export type Tx = pg.PoolClient

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error('DATABASE_URL ausente')
  return new pg.Pool({ connectionString, max: 10 })
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect()
  try {
    await tx.query('BEGIN')
    const out = await fn(tx)
    await tx.query('COMMIT')
    return out
  } catch (err) {
    try { await tx.query('ROLLBACK') } catch { /* conexão pode ter caído; o erro original importa */ }
    throw err
  } finally {
    tx.release()
  }
}

/** Trava consultiva de transação (liberada no COMMIT/ROLLBACK). Chave derivada do texto. */
export async function txLock(tx: Tx, key: string): Promise<void> {
  const h = createHash('sha256').update(key).digest()
  await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [h.readBigInt64BE(0).toString()])
}

export async function recordTransition(
  tx: Tx, entity: string, entityId: string, from: string | null, to: string, source: string, reason?: string,
): Promise<void> {
  await tx.query(
    'INSERT INTO state_transitions (entity, entity_id, from_state, to_state, reason, source) VALUES ($1,$2,$3,$4,$5,$6)',
    [entity, entityId, from, to, reason ?? null, source],
  )
}

export async function enqueue(tx: Tx, topic: string, entityId: string, payload: Record<string, unknown> = {}): Promise<void> {
  await tx.query('INSERT INTO outbox (topic, entity_id, payload) VALUES ($1,$2,$3)', [topic, entityId, JSON.stringify(payload)])
}
