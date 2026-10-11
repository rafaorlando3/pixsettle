// v7.3 (10/10/2026; revisões X-1211 e X-1212): vínculo do banco com o perfil da instância de produção dos afiliados.
// O perfil é (modo, rede, token, tesouraria, política de cotação). Ordem do boot, nesta ordem e sem exceção:
//   1. só a identidade (016, idempotente) num banco novo; nenhuma migração de negócio ainda;
//   2. sob trava: perfil gravado é comparado (qualquer diferença recusa); sem perfil, banco com dado da demo ou com dado
//      financeiro legado é recusado (nunca adotado em silêncio); banco limpo é preso a este perfil;
//   3. só então as migrações de negócio, o servidor, o worker e qualquer processo com chave.
// A linha é imutável no banco (gatilho): entre a conferência do launcher e a do core não há como trocar o vínculo.
// Banco legado só entra por adoção EXPLÍCITA (`adoptLegacyDatabase`, comando próprio), validada e auditada.
import { readFileSync } from 'node:fs'
import { withTx, type Db, type Tx } from '../db.js'

export type InstanceMode = 'production' | 'rehearsal'
export type QuotePolicy = 'binance_usdtbrl' | 'simulated'
export type InstanceProfile = { mode: InstanceMode; chainId: number; token: string; treasury: string; quoteSource: QuotePolicy }
export type BoundProfile = InstanceProfile & { claimedAt: string; claimedNow: boolean; adopted: boolean }

export class InstanceProfileError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`) }
}

const IDENTITY_SQL = readFileSync(new URL('../../migrations/016_instance_profile.sql', import.meta.url), 'utf8')
/** Dado da demo: a produção dos afiliados nunca grava estas tabelas. */
const DEMO_TABLES = ['orders', 'pix_charges', 'pilot_charges', 'attested_events'] as const
/** Dado financeiro: banco sem perfil com linha em qualquer uma delas é legado. */
const FINANCIAL_TABLES = ['affiliate_commissions', 'affiliate_ledger', 'affiliate_withdrawals', 'affiliate_receipts', 'settlements'] as const

const norm = (p: InstanceProfile): InstanceProfile => ({ ...p, token: p.token.toLowerCase(), treasury: p.treasury.toLowerCase() })
const describe = (p: InstanceProfile) => `${p.mode} na rede ${p.chainId}, token ${p.token}, tesouraria ${p.treasury}, cotação ${p.quoteSource}`

/** Chave da trava de sessão do boot da produção dos afiliados (launcher, core e adoção): um condutor por vez. */
export const BOOT_LOCK_KEY = 72_170_001

/**
 * Roda `fn` com a trava de sessão do boot: identidade, perfil e migrações de um boot nunca se cruzam com os de outro (o
 * segundo espera e depois confere o perfil que o primeiro gravou). Quem chama `bindDatabaseProfile`, `adoptLegacyDatabase`
 * ou migra no boot faz isso aqui dentro.
 */
export async function withBootLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('SELECT pg_advisory_lock($1)', [BOOT_LOCK_KEY])
    try { return await fn() } finally { await c.query('SELECT pg_advisory_unlock($1)', [BOOT_LOCK_KEY]) }
  } finally { c.release() }
}

/** 1. Só a identidade, sem nenhuma migração de negócio (o mesmo SQL da 016, idempotente). */
export async function ensureIdentity(db: Db): Promise<void> {
  await db.query(IDENTITY_SQL)
}

async function rowCounts(tx: Tx, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of tables) {
    const exists = (await tx.query('SELECT to_regclass($1) IS NOT NULL AS e', [`public.${t}`])).rows[0].e
    if (!exists) continue
    const n = Number((await tx.query(`SELECT count(*)::bigint AS n FROM ${t}`)).rows[0].n)
    if (n > 0) out[t] = n
  }
  return out
}

function readRow(row: any): InstanceProfile & { claimedAt: string; adopted: boolean } {
  return {
    mode: row.mode, chainId: Number(row.chain_id), token: String(row.token), treasury: String(row.treasury),
    quoteSource: row.quote_source, claimedAt: new Date(row.claimed_at).toISOString(), adopted: Boolean(row.adopted),
  }
}

/** 2. Confere ou prende o banco ao perfil, sob trava da tabela (dois boots ao mesmo tempo terminam com um vínculo só). */
export async function bindDatabaseProfile(db: Db, profile: InstanceProfile): Promise<BoundProfile> {
  const want = norm(profile)
  await ensureIdentity(db)
  return withTx(db, async tx => {
    await tx.query('LOCK TABLE instance_profile IN SHARE ROW EXCLUSIVE MODE')
    const row = (await tx.query('SELECT * FROM instance_profile WHERE id = 1')).rows[0]
    if (row) {
      const have = readRow(row)
      if (have.mode !== want.mode || have.chainId !== want.chainId || have.token !== want.token || have.treasury !== want.treasury || have.quoteSource !== want.quoteSource) {
        throw new InstanceProfileError('database_profile_mismatch', `banco preso a ${describe(have)}; esta instância é ${describe(want)}. Use o banco certo; trocar o vínculo é gesto manual registrado`)
      }
      return { ...have, claimedNow: false }
    }
    const demo = await rowCounts(tx, DEMO_TABLES)
    if (Object.keys(demo).length) throw new InstanceProfileError('database_has_demo_data', `o banco tem dado da demo (${JSON.stringify(demo)}); a produção dos afiliados não usa esse banco`)
    const legacy = await rowCounts(tx, FINANCIAL_TABLES)
    if (Object.keys(legacy).length) {
      throw new InstanceProfileError('database_profile_missing_with_data', `banco sem perfil e com dado financeiro (${JSON.stringify(legacy)}): nada é adotado em silêncio; use a adoção explícita (core/scripts/affiliates-adopt-profile.ts), validada e auditada, ou um banco novo`)
    }
    const ins = (await tx.query('INSERT INTO instance_profile (id, mode, chain_id, token, treasury, quote_source) VALUES (1, $1, $2, $3, $4, $5) RETURNING claimed_at',
      [want.mode, want.chainId, want.token, want.treasury, want.quoteSource])).rows[0]
    return { ...want, claimedAt: new Date(ins.claimed_at).toISOString(), claimedNow: true, adopted: false }
  })
}

/**
 * Adoção EXPLÍCITA de um banco legado (com dado financeiro e sem perfil). Valida o dado contra o perfil pedido antes de
 * gravar e deixa auditoria em state_transitions (quem, por quê, contagens). Produção nunca adota comissão de cotação
 * simulada nem liquidação de outra rede ou de outro token.
 */
export async function adoptLegacyDatabase(db: Db, profile: InstanceProfile, by: { operator: string; note: string }) {
  const want = norm(profile)
  if (!/^[a-z0-9_.@-]{2,64}$/i.test(by.operator)) throw new InstanceProfileError('invalid_operator', 'operator deve ser um nome curto (2 a 64 caracteres, sem espaços)')
  if (by.note.trim().length < 10) throw new InstanceProfileError('invalid_note', 'note precisa explicar a adoção (10 caracteres ou mais)')
  await ensureIdentity(db)
  return withTx(db, async tx => {
    await tx.query('LOCK TABLE instance_profile IN SHARE ROW EXCLUSIVE MODE')
    if ((await tx.query('SELECT 1 FROM instance_profile WHERE id = 1')).rowCount) throw new InstanceProfileError('database_profile_exists', 'o banco já tem perfil; adoção é só para banco legado sem perfil')
    const demo = await rowCounts(tx, DEMO_TABLES)
    if (Object.keys(demo).length) throw new InstanceProfileError('database_has_demo_data', `o banco tem dado da demo (${JSON.stringify(demo)})`)
    const counts = await rowCounts(tx, FINANCIAL_TABLES)
    const problems: string[] = []
    const has = async (t: string) => (await tx.query('SELECT to_regclass($1) IS NOT NULL AS e', [`public.${t}`])).rows[0].e
    if (await has('affiliate_commissions')) {
      const sim = Number((await tx.query(`SELECT count(*)::bigint AS n FROM affiliate_commissions WHERE quote_source = 'simulated'`)).rows[0].n)
      if (want.mode === 'production' && sim > 0) problems.push(`${sim} comissão(ões) com cotação simulada`)
      if (want.quoteSource === 'binance_usdtbrl' && want.mode === 'rehearsal' && sim > 0) problems.push(`${sim} comissão(ões) com cotação simulada num perfil de cotação binance_usdtbrl`)
    }
    if (await has('settlements')) {
      const other = Number((await tx.query(`SELECT count(*)::bigint AS n FROM settlements WHERE chain_id <> $1 OR lower(token) <> $2`, [want.chainId, want.token])).rows[0].n)
      if (other > 0) problems.push(`${other} liquidação(ões) de outra rede ou de outro token`)
    }
    if (problems.length) throw new InstanceProfileError('legacy_data_incompatible', `o dado legado não combina com ${describe(want)}: ${problems.join('; ')}`)
    const ins = (await tx.query('INSERT INTO instance_profile (id, mode, chain_id, token, treasury, quote_source, adopted) VALUES (1, $1, $2, $3, $4, $5, true) RETURNING claimed_at',
      [want.mode, want.chainId, want.token, want.treasury, want.quoteSource])).rows[0]
    await tx.query(`INSERT INTO state_transitions (entity, entity_id, from_state, to_state, reason, source) VALUES ('instance_profile', '1', NULL, 'adopted', $1, 'adopt')`,
      [JSON.stringify({ profile: want, counts, operator: by.operator, note: by.note.trim().slice(0, 500) })])
    return { ...want, claimedAt: new Date(ins.claimed_at).toISOString(), claimedNow: true, adopted: true, counts }
  })
}
