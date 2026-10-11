// Acesso ao PostgreSQL. Regra (X-0003): cada transação usa UMA conexão reservada do BEGIN ao
// COMMIT/ROLLBACK, incluindo travas e escrita na outbox. Nunca espalhar passos em pool.query.
import pg from 'pg'
import { createHash } from 'node:crypto'

export type Db = pg.Pool
export type Tx = pg.PoolClient

export type PoolOptions = {
  /** v7.4: impressão digital do perfil da instância (`profileFingerprint`); cada conexão declara `pixsettle.profile` no início
   *  (opção do servidor, `-c`), e a guarda de escrita do banco preso só aceita a sessão que declarou o perfil certo. */
  profileFingerprint?: string
  /** nome da aplicação em pg_stat_activity (sem segredo) */
  applicationName?: string
  max?: number
}

export function createPool(connectionString = process.env.DATABASE_URL, opts: PoolOptions = {}): Db {
  if (!connectionString) throw new Error('DATABASE_URL ausente')
  if (opts.profileFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(opts.profileFingerprint)) throw new Error('profile_fingerprint_invalid: 64 hexadecimais')
  const pool = new pg.Pool({
    connectionString, max: opts.max ?? 10,
    ...(opts.profileFingerprint ? { options: `-c pixsettle.profile=${opts.profileFingerprint}` } : {}),
    ...(opts.applicationName ? { application_name: opts.applicationName } : {}),
  })
  // Conexão ociosa derrubada pelo servidor (reinício, failover): registra o motivo e segue; o pool reabre.
  pool.on('error', err => console.error(`pg: conexão ociosa caiu: ${(err as any).code ?? ''} ${err.message}`))
  return pool
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

/** Chave numérica (bigint, em texto) da trava consultiva derivada do texto: os 8 primeiros bytes do sha256. */
export function lockKeyOf(key: string): string {
  return createHash('sha256').update(key).digest().readBigInt64BE(0).toString()
}

/** Trava consultiva de transação (liberada no COMMIT/ROLLBACK). Chave derivada do texto. */
export async function txLock(tx: Tx, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKeyOf(key)])
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
