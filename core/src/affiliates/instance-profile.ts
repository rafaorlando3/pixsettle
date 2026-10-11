// v7.3 (10/10/2026; revisões X-1211 e X-1212), v7.4 (11/10/2026; revisão X-1222) e v7.5 (11/10/2026; revisão X-1277):
// vínculo do banco com o perfil da instância de produção dos afiliados. O perfil é (modo, rede, token, tesouraria, política de cotação).
// Ordem do boot, nesta ordem e sem exceção, tudo sob a trava de sessão do boot:
//   1. leitura do catálogo e da linha do perfil, sem escrever nada: identidade desatualizada (016 da primeira v7.3) ou
//      adulterada é recusada; perfil gravado diferente é recusado; banco sem perfil e com qualquer dado é recusado (nunca
//      adotado: não existe adoção de legado na v7.4);
//   2. só então escreve, e só num banco NOVO e vazio, numa transação (identidade, trava das tabelas, segunda conferência de
//      que está vazio, a linha do perfil, o selo da impressão e a guarda de escrita). v7.5 (X-1277): banco já preso só sobe
//      com a identidade atual completa e intacta (selo igual à linha, guarda ligada em O ou A em toda tabela, linha nunca
//      adotada); identidade de versão anterior, adotada ou desmontada é recusada só lendo: o boot não atualiza nem conserta;
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

/** Identidade v7.5 (superconjunto da 016): executada pelo boot SÓ na transação que prende um banco novo. */
const IDENTITY_SQL = readFileSync(new URL('../../migrations/identity/instance_profile.sql', import.meta.url), 'utf8')

/**
 * v7.5.1 (X-1282): corpo instalado de cada função da identidade (o texto entre $$ do arquivo de identidade). O boot compara o
 * md5 do `prosrc` no banco com o deste arquivo: função trocada à mão (ex.: guarda que sempre deixa passar) não sobe.
 */
const IDENTITY_BODIES: Record<string, string> = Object.fromEntries(
  [...IDENTITY_SQL.matchAll(/CREATE OR REPLACE FUNCTION (instance_profile_\w+)\(\)[^$]*?AS \$\$([\s\S]*?)\$\$;/g)]
    .map(m => [m[1]!, createHash('md5').update(m[2]!, 'utf8').digest('hex')]),
)
for (const f of ['instance_profile_immutable', 'instance_profile_fingerprint', 'instance_profile_write_guard', 'instance_profile_guard_install', 'instance_profile_seal']) {
  if (!IDENTITY_BODIES[f]) throw new Error(`identity_file_invalid: corpo de ${f}() não encontrado no arquivo de identidade`)
}

/**
 * v7.5.1 (X-1282, V75-K5-O): a guarda de verdade, não só o nome: função instance_profile_write_guard(), BEFORE INSERT OR
 * UPDATE OR DELETE OR TRUNCATE FOR EACH STATEMENT (tgtype 62), sem WHEN, sem argumentos, sem UPDATE OF, não é de
 * restrição, ligada em O ou A. Usado no censo da cobertura (`t` = pg_trigger).
 */
const GENUINE_GUARD = `t.tgname = 'instance_profile_write_guard' AND t.tgenabled IN ('O', 'A')
  AND t.tgfoid = to_regprocedure('public.instance_profile_write_guard()') AND t.tgtype = 62 AND t.tgqual IS NULL
  AND t.tgnargs = 0 AND t.tgconstraint = 0 AND coalesce(array_length(t.tgattr::int2[], 1), 0) = 0`
/** Gatilhos da linha do perfil: função instance_profile_immutable(); BEFORE UPDATE OR DELETE FOR EACH ROW (27) e BEFORE TRUNCATE FOR EACH STATEMENT (34). */
const PROFILE_TRIGGERS: Record<string, number> = { instance_profile_immutable: 27, instance_profile_no_truncate: 34 }

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
  /** identidade de versão anterior ou incompleta (v7.3 corrigida b8cc379, v7.4 sem o selo, peça removida). Banco sem linha:
   *  o boot instala a identidade nova junto com a linha (banco vazio). Banco COM linha: recusado (v7.5, X-1277 B3). */
  | { kind: 'upgrade'; missing: string[] }
  /** tabela criada pela 016 da primeira v7.3 (8ec4b9d), sem quote_source/adopted */
  | { kind: 'outdated'; missing: string[] }
  /** proteção removida, desligada ou em modo réplica (gatilho do perfil ausente ou fora de O/A, guarda fora de O/A) */
  | { kind: 'tampered'; detail: string }

const PROFILE_COLUMNS = ['adopted', 'chain_id', 'claimed_at', 'id', 'mode', 'quote_source', 'token', 'treasury']

/** Estados de gatilho que disparam numa sessão normal (origem/local): O (origem) e A (sempre). R só dispara em réplica e D
 *  está desligado: os dois contam como proteção fora do ar (v7.5, X-1277 K5). */
const FIRES = new Set(['O', 'A'])
const triggerMode = (e: string) => (e === 'D' ? 'desligado (D)' : e === 'R' ? 'em modo réplica (R), não dispara na origem' : `no estado ${e}`)

/** v7.4 (X-1222, K2/K6) e v7.5 (X-1277 K5): estado da identidade, SÓ lendo o catálogo (nenhuma escrita, nem em banco que será recusado). */
export async function identityState(q: Db | Tx): Promise<IdentityState> {
  const base = (await q.query(`SELECT to_regclass('public.instance_profile')::oid AS rel,
      to_regprocedure('public.instance_profile_fingerprint()') IS NOT NULL AS fp_fn,
      to_regprocedure('public.instance_profile_write_guard()') IS NOT NULL AS guard_fn,
      to_regprocedure('public.instance_profile_guard_install()') IS NOT NULL AS installer_fn,
      to_regprocedure('public.instance_profile_sealed_fingerprint()') IS NOT NULL AS sealed_fn,
      to_regprocedure('public.instance_profile_seal()') IS NOT NULL AS seal_fn,
      (SELECT string_agg(c.relname::text || ':' || t.tgenabled::text, ',' ORDER BY c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND t.tgname = 'instance_profile_write_guard' AND t.tgenabled NOT IN ('O', 'A')) AS guards_off,
      (SELECT string_agg(c.relname::text, ',' ORDER BY c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND t.tgname = 'instance_profile_write_guard' AND t.tgenabled IN ('O', 'A') AND NOT (${GENUINE_GUARD})) AS guards_fake`)).rows[0]
  if (base.rel === null) return { kind: 'absent' }
  const cols = (await q.query(`SELECT attname::text AS a FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`, [base.rel])).rows.map(r => r.a as string)
  const missingCols = PROFILE_COLUMNS.filter(c => !cols.includes(c))
  if (missingCols.length) {
    const v73a = missingCols.every(c => c === 'quote_source' || c === 'adopted')
    return v73a ? { kind: 'outdated', missing: missingCols } : { kind: 'tampered', detail: `instance_profile sem as colunas ${missingCols.join(', ')}` }
  }
  const trgRows = (await q.query(`SELECT tgname::text AS n, tgenabled::text AS e,
      (tgfoid = to_regprocedure('public.instance_profile_immutable()') AND tgqual IS NULL AND tgnargs = 0 AND tgconstraint = 0
        AND coalesce(array_length(tgattr::int2[], 1), 0) = 0) AS fn_ok, tgtype::int AS ty, tgfoid::regprocedure::text AS fn
      FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal`, [base.rel])).rows
  const trg = new Map(trgRows.map(r => [r.n as string, r.e as string]))
  // v7.5.1 (X-1282): gatilho do perfil com o nome certo mas outra definição (função, eventos, momento, nível, condição) é adulteração
  for (const r of trgRows) {
    const want = PROFILE_TRIGGERS[r.n as string]
    if (want !== undefined && (!r.fn_ok || Number(r.ty) !== want)) return { kind: 'tampered', detail: `gatilho ${r.n} com definição diferente da instalada (função ${r.fn}, tipo ${r.ty})` }
  }
  const immutable = trg.get('instance_profile_immutable')
  if (!immutable) return { kind: 'tampered', detail: 'gatilho instance_profile_immutable ausente' }
  if (!FIRES.has(immutable)) return { kind: 'tampered', detail: `gatilho instance_profile_immutable ${triggerMode(immutable)}` }
  const noTruncate = trg.get('instance_profile_no_truncate')
  if (noTruncate !== undefined && !FIRES.has(noTruncate)) return { kind: 'tampered', detail: `gatilho instance_profile_no_truncate ${triggerMode(noTruncate)}` }
  if (base.guards_off) {
    const list = String(base.guards_off).split(',').map(x => { const [t, e] = x.split(':'); return `${t} ${triggerMode(e!)}` })
    return { kind: 'tampered', detail: `guarda de escrita fora do ar: ${list.join('; ')}` }
  }
  if (base.guards_fake) return { kind: 'tampered', detail: `gatilho com o nome da guarda que não é a guarda (função, eventos, momento, nível ou condição diferentes) em: ${String(base.guards_fake).replace(/,/g, ', ')}` }
  // v7.5.1 (X-1282): função da identidade com corpo diferente do instalado conta como peça desatualizada (banco preso: recusa;
  // banco sem linha: o boot reinstala tudo na transação que prende)
  const bodies = new Map((await q.query(`SELECT p.proname::text AS n, md5(p.prosrc) AS h FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.pronargs = 0 AND p.proname = ANY($1::text[])`, [Object.keys(IDENTITY_BODIES)])).rows.map(r => [r.n as string, r.h as string]))
  const changed = Object.entries(IDENTITY_BODIES).filter(([n, h]) => bodies.has(n) && bodies.get(n) !== h).map(([n]) => `${n}() (corpo diferente do instalado)`)
  const missing = [
    ...(noTruncate !== undefined ? [] : ['instance_profile_no_truncate']),
    ...(base.fp_fn ? [] : ['instance_profile_fingerprint()']),
    ...(base.guard_fn ? [] : ['instance_profile_write_guard()']),
    ...(base.installer_fn ? [] : ['instance_profile_guard_install()']),
    ...(base.sealed_fn ? [] : ['instance_profile_sealed_fingerprint()']),
    ...(base.seal_fn ? [] : ['instance_profile_seal()']),
    ...changed,
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

/**
 * v7.5 (X-1277): banco COM linha só sobe com a identidade atual, completa e intacta. Tudo só lendo; qualquer falta recusa e o
 * banco fica igual (nada é atualizado nem consertado no boot: reparo é gesto manual registrado).
 *  - B1: linha adotada (adopted = true, da adoção que a b8cc379 oferecia) não prova a origem dos dados: recusa;
 *  - B3: identidade de versão anterior ou incompleta (estado `upgrade`): recusa, em vez de atualizar com uma janela sem guarda;
 *  - H2: impressão selada ausente ou diferente da linha: recusa;
 *  - toda tabela do esquema public (menos a do perfil) com a guarda em O ou A: tabela sem guarda recusa.
 */
async function assertBoundIntact(q: Db | Tx, state: IdentityState, have: { adopted: boolean }): Promise<void> {
  if (have.adopted) {
    throw new InstanceProfileError('database_profile_adopted', 'banco preso por ADOÇÃO de legado (adopted = true, caminho da b8cc379 que não existe mais): o perfil igual não prova a origem do que já estava gravado. Use um banco novo; o Hub reenvia pela API')
  }
  if (state.kind === 'upgrade') {
    throw new InstanceProfileError('database_identity_not_current', `banco preso com identidade de versão anterior ou incompleta (falta ${state.missing.join(', ')}): esta versão não atualiza nem conserta identidade de banco preso no boot. Use um banco novo (atualizar é gesto manual registrado)`)
  }
  const seal = (await q.query(`SELECT instance_profile_sealed_fingerprint() AS sealed, instance_profile_fingerprint() AS fp`)).rows[0]
  if (!seal.sealed || seal.sealed !== seal.fp) {
    throw new InstanceProfileError('database_profile_guard_missing', `impressão selada ${seal.sealed ? 'diferente da linha do perfil' : 'ausente'}; o vínculo do banco perdeu a proteção e nada sobe até um reparo manual registrado`)
  }
  const bare = await unguardedTables(q)
  if (bare.length) {
    throw new InstanceProfileError('database_profile_guard_missing', `tabela(s) sem a guarda de escrita: ${bare.join(', ')}; o vínculo do banco perdeu a proteção e nada sobe até um reparo manual registrado`)
  }
}

/** Tabelas do esquema public (menos a do perfil) sem a guarda de escrita ligada em O ou A. Só lê. */
async function unguardedTables(q: Db | Tx): Promise<string[]> {
  return (await q.query(`SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> 'instance_profile'
       AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND ${GENUINE_GUARD})
     ORDER BY 1`)).rows.map(r => r.t as string)
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
 * banco recusado fica exatamente como estava. Escreve só ao prender um banco novo e vazio, numa transação com as tabelas
 * travadas contra escritores (v7.5: não existe mais a atualização de identidade de banco preso).
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
      await assertBoundIntact(db, state, have) // v7.5 (X-1277 B1, B3, H2): só lendo; nada é atualizado nem consertado
      return { ...have, claimedNow: false }
    }
  }
  await assertClaimable(db) // recusa sem escrever
  return withBindTx(db, async tx => {
    if (state.kind !== 'current') await tx.query(IDENTITY_SQL)
    await tx.query('LOCK TABLE instance_profile IN SHARE ROW EXCLUSIVE MODE')
    const again = (await tx.query('SELECT * FROM instance_profile WHERE id = 1')).rows[0]
    if (again) {
      // v7.5.2 (X-1282, BANCO 2): uma linha gravada por fora entre a leitura inicial e a trava passa pelas MESMAS conferências
      // do banco preso (adotada, identidade, selo, cobertura); qualquer falta desfaz a transação inteira
      const have = readRow(again)
      assertSameProfile(have, want)
      const now = await identityState(tx)
      refuseBadIdentity(now)
      await assertBoundIntact(tx, now, have)
      return { ...have, claimedNow: false }
    }
    // escritor que não usa a trava do boot (código antigo): fica parado até o fim desta transação e depois esbarra na guarda
    const tables = await appTables(tx)
    if (tables.length) await tx.query(`LOCK TABLE ${tables.map(t => `public.${ident(t)}`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`)
    await assertClaimable(tx)
    const ins = (await tx.query('INSERT INTO instance_profile (id, mode, chain_id, token, treasury, quote_source) VALUES (1, $1, $2, $3, $4, $5) RETURNING claimed_at',
      [want.mode, want.chainId, want.token, want.treasury, want.quoteSource])).rows[0]
    // v7.5 (X-1277 H2): selo da impressão no catálogo ANTES da guarda, na mesma transação da linha
    const sealed = (await tx.query('SELECT instance_profile_seal() AS fp')).rows[0].fp as string
    if (sealed !== profileFingerprint(want)) throw new InstanceProfileError('database_profile_seal_mismatch', 'a impressão selada pelo banco não bate com a do perfil da instância')
    await tx.query('SELECT instance_profile_guard_install()')
    // v7.5: segunda camada, na mesma transação: toda tabela sai daqui com a guarda em O ou A (senão desfaz o vínculo inteiro)
    const gaps = await unguardedTables(tx)
    if (gaps.length) throw new InstanceProfileError('database_profile_guard_missing', `ao prender, tabela(s) sem a guarda em O ou A: ${gaps.join(', ')}; nada foi preso`)
    return { ...want, claimedAt: new Date(ins.claimed_at).toISOString(), claimedNow: true, adopted: false }
  })
}

/**
 * v7.5.2 (X-1282, BANCO 3): a transação que prende é sempre READ COMMITTED, declarado no BEGIN e conferido: cada comando
 * depois das travas enxerga o que um escritor antigo confirmou enquanto esperávamos (com REPEATABLE READ herdado do banco, a
 * recontagem depois do LOCK usaria a foto do primeiro comando e prenderia um banco com dado).
 */
async function withBindTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect()
  try {
    await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const iso = String((await tx.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation ?? '')
    if (iso !== 'read committed') throw new InstanceProfileError('database_bind_isolation', `a transação que prende ficou em ${iso || 'isolamento desconhecido'}; precisa ser read committed`)
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
  await assertBoundIntact(db, state, have) // v7.5 (X-1277): a ferramenta também não escreve em banco adotado ou desmontado
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name as string))
  const pending = migrationFiles.filter(f => !done.has(f))
  if (pending.length) throw new InstanceProfileError('database_not_ready', `migração pendente (${pending.join(', ')}): só o boot da produção migra, sob a trava`)
  return { ...have, claimedNow: false }
}
