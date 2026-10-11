// v7.3 (10/10/2026; revisões X-1211 e X-1212) e v7.4 (11/10/2026; revisão X-1222): vínculo do banco com o perfil da
// instância de produção dos afiliados. O perfil é (modo, rede, token, tesouraria, política de cotação).
// Ordem do boot, nesta ordem e sem exceção, tudo sob a trava de sessão do boot:
//   1. leitura do catálogo e da linha do perfil, sem escrever nada: identidade desatualizada (016 da primeira v7.3) ou
//      adulterada é recusada; perfil gravado diferente é recusado; banco sem perfil e com qualquer dado é recusado (nunca
//      adotado: não existe adoção de legado na v7.4);
//   2. só então escreve: banco NOVO e vazio é preso numa transação (identidade, trava das tabelas, segunda conferência de
//      que está vazio, a linha do perfil e a guarda de escrita); banco já preso a ESTE perfil só ganha a identidade nova;
//   3. depois as migrações de negócio (cada tabela nova nasce com a guarda), o servidor, o worker e qualquer processo com chave.
// A linha do perfil recusa UPDATE, DELETE e TRUNCATE por gatilho e a guarda de escrita recusa sessão que não declarou o
// perfil (código antigo). Dono ou superusuário do banco ainda pode apagar tabela ou desligar gatilho: operação manual,
// fora do runtime, registrada; o runtime não faz nenhuma delas.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { withTx, type Db, type Tx } from '../db.js'

export type InstanceMode = 'production' | 'rehearsal'
export type QuotePolicy = 'binance_usdtbrl' | 'simulated'
export type InstanceProfile = { mode: InstanceMode; chainId: number; token: string; treasury: string; quoteSource: QuotePolicy }
export type BoundProfile = InstanceProfile & { claimedAt: string; claimedNow: boolean; adopted: boolean }

export class InstanceProfileError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`) }
}

/** Identidade v7.4 (superconjunto da 016): executada pelo boot só num banco novo ou num banco preso a este mesmo perfil. */
const IDENTITY_SQL = readFileSync(new URL('../../migrations/identity/instance_profile.sql', import.meta.url), 'utf8')

/** Tabelas do trilho dos afiliados (as demais são da demo do concurso). */
const AFFILIATE_TABLES = new Set(['merchants', 'settlements', 'settlement_attempts', 'state_transitions', 'outbox', 'schema_migrations'])
const isAffiliateTable = (t: string) => AFFILIATE_TABLES.has(t) || t.startsWith('affiliate_')

const norm = (p: InstanceProfile): InstanceProfile => ({ ...p, token: p.token.toLowerCase(), treasury: p.treasury.toLowerCase() })
const describe = (p: InstanceProfile) => `${p.mode} na rede ${p.chainId}, token ${p.token}, tesouraria ${p.treasury}, cotação ${p.quoteSource}`
const ident = (t: string) => `"${t.replace(/"/g, '""')}"`

/** Chave da trava de sessão do boot da produção dos afiliados (launcher, core e ferramentas): um condutor por vez. */
export const BOOT_LOCK_KEY = 72_170_001

/**
 * v7.4: impressão digital do perfil (sha256 de "modo|rede|token|tesouraria|cotação", endereços em minúsculas). O banco calcula
 * a mesma conta sobre a linha gravada (`instance_profile_fingerprint()`); a sessão que a declara em `pixsettle.profile`
 * passa pela guarda de escrita.
 */
export function profileFingerprint(profile: InstanceProfile): string {
  const p = norm(profile)
  return createHash('sha256').update(`${p.mode}|${p.chainId}|${p.token}|${p.treasury}|${p.quoteSource}`, 'utf8').digest('hex')
}

/**
 * Roda `fn` com a trava de sessão do boot: identidade, perfil e migrações de um boot nunca se cruzam com os de outro (o
 * segundo espera e depois confere o perfil que o primeiro gravou). Quem chama `bindDatabaseProfile` ou migra no boot faz
 * isso aqui dentro. Trava cooperativa: só serializa quem também a pede (a guarda de escrita cuida de quem não pede).
 */
export async function withBootLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('SELECT pg_advisory_lock($1)', [BOOT_LOCK_KEY])
    try { return await fn() } finally { await c.query('SELECT pg_advisory_unlock($1)', [BOOT_LOCK_KEY]) }
  } finally { c.release() }
}

export type IdentityState =
  | { kind: 'absent' }
  | { kind: 'current' }
  /** banco preso pela v7.3 corrigida (b8cc379): falta o gatilho de TRUNCATE e a guarda de escrita */
  | { kind: 'upgrade'; missing: string[] }
  /** tabela criada pela 016 da primeira v7.3 (8ec4b9d), sem quote_source/adopted */
  | { kind: 'outdated'; missing: string[] }
  /** proteção removida ou desligada (gatilho do perfil ausente ou desligado, guarda desligada) */
  | { kind: 'tampered'; detail: string }

const PROFILE_COLUMNS = ['adopted', 'chain_id', 'claimed_at', 'id', 'mode', 'quote_source', 'token', 'treasury']

/** v7.4 (X-1222, K2/K6): estado da identidade, SÓ lendo o catálogo (nenhuma escrita, nem em banco que será recusado). */
export async function identityState(q: Db | Tx): Promise<IdentityState> {
  const base = (await q.query(`SELECT to_regclass('public.instance_profile')::oid AS rel,
      to_regprocedure('public.instance_profile_fingerprint()') IS NOT NULL AS fp_fn,
      to_regprocedure('public.instance_profile_write_guard()') IS NOT NULL AS guard_fn,
      to_regprocedure('public.instance_profile_guard_install()') IS NOT NULL AS installer_fn,
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND t.tgname = 'instance_profile_write_guard' AND t.tgenabled = 'D') AS guards_off`)).rows[0]
  if (base.rel === null) return { kind: 'absent' }
  const cols = (await q.query(`SELECT attname::text AS a FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`, [base.rel])).rows.map(r => r.a as string)
  const missingCols = PROFILE_COLUMNS.filter(c => !cols.includes(c))
  if (missingCols.length) {
    const v73a = missingCols.every(c => c === 'quote_source' || c === 'adopted')
    return v73a ? { kind: 'outdated', missing: missingCols } : { kind: 'tampered', detail: `instance_profile sem as colunas ${missingCols.join(', ')}` }
  }
  const trg = new Map((await q.query(`SELECT tgname::text AS n, tgenabled::text AS e FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal`, [base.rel])).rows.map(r => [r.n as string, r.e as string]))
  const immutable = trg.get('instance_profile_immutable')
  if (!immutable || immutable === 'D') return { kind: 'tampered', detail: `gatilho instance_profile_immutable ${immutable ? 'desligado' : 'ausente'}` }
  if (trg.get('instance_profile_no_truncate') === 'D') return { kind: 'tampered', detail: 'gatilho instance_profile_no_truncate desligado' }
  if (base.guards_off > 0) return { kind: 'tampered', detail: `${base.guards_off} gatilho(s) instance_profile_write_guard desligado(s)` }
  const missing = [
    ...(trg.has('instance_profile_no_truncate') ? [] : ['instance_profile_no_truncate']),
    ...(base.fp_fn ? [] : ['instance_profile_fingerprint()']),
    ...(base.guard_fn ? [] : ['instance_profile_write_guard()']),
    ...(base.installer_fn ? [] : ['instance_profile_guard_install()']),
  ]
  return missing.length ? { kind: 'upgrade', missing } : { kind: 'current' }
}

function refuseBadIdentity(state: IdentityState): void {
  if (state.kind === 'outdated') {
    throw new InstanceProfileError('database_profile_schema_outdated', `instance_profile foi criada pela 016 da primeira v7.3 (8ec4b9d), sem ${state.missing.join(' e ')}; essa versão nunca foi aplicada a um banco em uso e não há atualização automática: use um banco novo (trocar a estrutura do vínculo é gesto manual registrado)`)
  }
  if (state.kind === 'tampered') {
    throw new InstanceProfileError('database_profile_guard_missing', `${state.detail}; o vínculo do banco perdeu a proteção e nada sobe até um reparo manual registrado`)
  }
}

function readRow(row: any): InstanceProfile & { claimedAt: string; adopted: boolean } {
  return {
    mode: row.mode, chainId: Number(row.chain_id), token: String(row.token), treasury: String(row.treasury),
    quoteSource: row.quote_source, claimedAt: new Date(row.claimed_at).toISOString(), adopted: Boolean(row.adopted),
  }
}

function assertSameProfile(have: InstanceProfile, want: InstanceProfile): void {
  if (have.mode !== want.mode || have.chainId !== want.chainId || have.token !== want.token || have.treasury !== want.treasury || have.quoteSource !== want.quoteSource) {
    throw new InstanceProfileError('database_profile_mismatch', `banco preso a ${describe(have)}; esta instância é ${describe(want)}. Use o banco certo; trocar o vínculo é gesto manual registrado`)
  }
}

/** Tabelas do esquema public (menos a do perfil), em ordem fixa. */
async function appTables(q: Db | Tx): Promise<string[]> {
  return (await q.query(`SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> 'instance_profile' ORDER BY c.relname`)).rows.map(r => r.t as string)
}

/**
 * v7.4 (X-1222, BANCO P1/P2): banco sem perfil só é preso VAZIO. Qualquer linha em qualquer tabela (fora o registro das
 * migrações e a auditoria que as próprias migrações gravam) recusa: dado da demo, ou dado legado sem perfil. Legado não tem
 * de onde provar modo, rede, token, tesouraria nem política de cotação das obrigações (a v7.2 não gravava isso), então
 * nunca é adotado: produção e ensaio começam num banco novo e o Hub reenvia pela API (idempotente pelo source_event_id).
 */
async function assertClaimable(q: Db | Tx): Promise<void> {
  const demo: Record<string, number> = {}
  const legacy: Record<string, number> = {}
  for (const t of await appTables(q)) {
    if (t === 'schema_migrations') continue
    const where = t === 'state_transitions' ? ` WHERE entity <> 'migration'` : ''
    const n = Number((await q.query(`SELECT count(*)::bigint AS n FROM public.${ident(t)}${where}`)).rows[0].n)
    if (n > 0) (isAffiliateTable(t) ? legacy : demo)[t] = n
  }
  if (Object.keys(demo).length) throw new InstanceProfileError('database_has_demo_data', `o banco tem dado da demo (${JSON.stringify(demo)}); a produção dos afiliados não usa esse banco`)
  if (Object.keys(legacy).length) {
    throw new InstanceProfileError('database_profile_missing_with_data', `banco sem perfil e com dado (${JSON.stringify(legacy)}): legado não grava modo, rede, token, tesouraria nem cotação de onde provar a origem, então nunca é adotado. Use um banco novo; o Hub reenvia as comissões pela API`)
  }
}

/**
 * 1+2. Confere ou prende o banco ao perfil. Tudo que recusa é decidido só lendo (catálogo, linha do perfil, contagens):
 * banco recusado fica exatamente como estava. Escreve só (a) ao prender um banco novo e vazio, numa transação com as
 * tabelas travadas contra escritores, ou (b) ao atualizar a identidade de um banco preso a este mesmo perfil.
 */
export async function bindDatabaseProfile(db: Db, profile: InstanceProfile): Promise<BoundProfile> {
  const want = norm(profile)
  const state = await identityState(db)
  refuseBadIdentity(state)
  if (state.kind !== 'absent') {
    const row = (await db.query('SELECT * FROM instance_profile WHERE id = 1')).rows[0]
    if (row) {
      const have = readRow(row)
      assertSameProfile(have, want)
      if (state.kind === 'upgrade') await withTx(db, async tx => { await tx.query(IDENTITY_SQL) }) // mesmo perfil: só a identidade nova
      return { ...have, claimedNow: false }
    }
  }
  await assertClaimable(db) // recusa sem escrever
  return withTx(db, async tx => {
    if (state.kind !== 'current') await tx.query(IDENTITY_SQL)
    await tx.query('LOCK TABLE instance_profile IN SHARE ROW EXCLUSIVE MODE')
    const again = (await tx.query('SELECT * FROM instance_profile WHERE id = 1')).rows[0]
    if (again) { const have = readRow(again); assertSameProfile(have, want); return { ...have, claimedNow: false } }
    // escritor que não usa a trava do boot (código antigo): fica parado até o fim desta transação e depois esbarra na guarda
    const tables = await appTables(tx)
    if (tables.length) await tx.query(`LOCK TABLE ${tables.map(t => `public.${ident(t)}`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`)
    await assertClaimable(tx)
    const ins = (await tx.query('INSERT INTO instance_profile (id, mode, chain_id, token, treasury, quote_source) VALUES (1, $1, $2, $3, $4, $5) RETURNING claimed_at',
      [want.mode, want.chainId, want.token, want.treasury, want.quoteSource])).rows[0]
    await tx.query('SELECT instance_profile_guard_install()')
    return { ...want, claimedAt: new Date(ins.claimed_at).toISOString(), claimedNow: true, adopted: false }
  })
}

/** Liga a guarda de escrita em toda tabela que ainda não a tem (fim do boot; sem efeito quando todas já têm). */
export async function installWriteGuard(db: Db): Promise<number> {
  return Number((await db.query('SELECT instance_profile_guard_install() AS n')).rows[0].n)
}

/**
 * Ferramentas (cadastro do lojista): exigem o banco já preso a ESTE perfil, com a identidade atual e sem migração
 * pendente. Só lê; nunca prende, nunca migra.
 */
export async function assertDatabaseBoundTo(db: Db, profile: InstanceProfile, migrationFiles: string[]): Promise<BoundProfile> {
  const state = await identityState(db)
  refuseBadIdentity(state)
  if (state.kind !== 'current') throw new InstanceProfileError('database_not_ready', 'banco sem o perfil atual: suba a produção (o boot prende o banco e migra) antes de usar a ferramenta')
  const row = (await db.query('SELECT * FROM instance_profile WHERE id = 1')).rows[0]
  if (!row) throw new InstanceProfileError('database_not_ready', 'banco ainda não foi preso a um perfil: suba a produção antes de usar a ferramenta')
  const have = readRow(row)
  assertSameProfile(have, norm(profile))
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name as string))
  const pending = migrationFiles.filter(f => !done.has(f))
  if (pending.length) throw new InstanceProfileError('database_not_ready', `migração pendente (${pending.join(', ')}): só o boot da produção migra, sob a trava`)
  return { ...have, claimedNow: false }
}
