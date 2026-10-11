// v7.3 (10/10/2026; revisões X-1211 e X-1212) e v7.4 (11/10/2026; revisão X-1222): o banco da produção dos afiliados fica
// preso a um perfil (modo, rede, token, tesouraria e política de cotação) ANTES das migrações de negócio, de qualquer escrita
// e de qualquer processo com chave. Recusa decidida só lendo (banco recusado fica igual, dado e catálogo), banco sem perfil só
// é preso vazio (legado nunca é adotado), código antigo é recusado pela guarda de escrita, e a ordem do launcher é plano
// público -> banco -> chave -> filhos.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, mkdtempSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { privateKeyToAccount } from 'viem/accounts'
import { startAffiliatesProduction, TEMPO_MAINNET_USDC } from '../src/affiliates/production.js'
import * as instanceProfile from '../src/affiliates/instance-profile.js'
import { bindDatabaseProfile, withBootLock, profileFingerprint, identityState, BOOT_LOCK_KEY, type InstanceProfile } from '../src/affiliates/instance-profile.js'
import { createPool } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { rollback } from '../src/rollback.js'
import { provisionMerchant } from '../src/affiliates/merchant-provision.js'
import { prepareLaunch, preflightDatabase, publicLaunchPlan } from '../scripts/start-production.js'

const ADMIN = process.env.TEST_DATABASE_ADMIN ?? 'postgres://pixsettle@localhost:5433/postgres?host=/tmp'
const TREASURY = '0xb2d7d888E8415F076A3BA4215F0686810a510265'
const OTHER = '0x0F39B346693C26618157b8FC2430f6F93660fDAf'
const MIGRATION_DIR = new URL('../migrations/', import.meta.url)
const MIGRATIONS = readdirSync(MIGRATION_DIR).filter(f => f.endsWith('.sql')).length
const TREASURY_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // chave pública de TESTE (hardhat #1)
const ISSUER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' // chave pública de TESTE (hardhat #2)
const AUDIT = fileURLToPath(new URL('./fixtures/process-audit.mjs', import.meta.url))
const LAUNCHER = fileURLToPath(new URL('../scripts/start-production.ts', import.meta.url))
const CORE = fileURLToPath(new URL('../src/affiliates/production.ts', import.meta.url))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

async function freshUrl(): Promise<string> {
  const name = 'pst_' + randomUUID().replace(/-/g, '').slice(0, 16)
  const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end()
  cleanups.push(async () => { const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE ${name} WITH (FORCE)`); await a.end() })
  const u = new URL(ADMIN); u.pathname = `/${name}`
  return u.toString()
}

const env = (url: string, over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  PIXSETTLE_PROFILE: 'affiliates_production', CHAIN_ID: '4217', TREASURY_ADDRESS: TREASURY, DATABASE_URL: url,
  AFFILIATE_QUOTE_SOURCE: 'binance_usdtbrl', PORT: '0', HOST: '127.0.0.1', ...over,
})
const REHEARSAL = { PRODUCTION_REHEARSAL: '1', AFFILIATE_QUOTE_SOURCE: 'simulated', AFFILIATE_SIM_PRICE4: '52130' }
const PROD: InstanceProfile = { mode: 'production', chainId: 4217, token: TEMPO_MAINNET_USDC, treasury: TREASURY, quoteSource: 'binance_usdtbrl' }
const REH: InstanceProfile = { ...PROD, mode: 'rehearsal', quoteSource: 'simulated' }

/** Cliente avulso; com `profile`, declara o perfil (como o runtime da v7.4); sem, é um escritor antigo. */
async function client(url: string, profile?: InstanceProfile) {
  const c = new pg.Client({ connectionString: url, ...(profile ? { options: `-c pixsettle.profile=${profileFingerprint(profile)}` } : {}) })
  await c.connect()
  return c
}
async function q(url: string, sql: string, params: unknown[] = [], profile?: InstanceProfile) {
  const c = await client(url, profile)
  try { return (await c.query(sql, params)).rows } finally { await c.end() }
}
const profileRows = (url: string) => q(url, 'SELECT mode, chain_id, token, treasury, quote_source, adopted FROM instance_profile')
const appliedMigrations = async (url: string) => (await q(url, `SELECT name FROM schema_migrations ORDER BY name`)).map(r => r.name as string)
async function boot(e: Record<string, string | undefined>) { const s = await startAffiliatesProduction(e); await s.stop() }
const port = (s: Awaited<ReturnType<typeof startAffiliatesProduction>>) => (s.app.server.address() as { port: number }).port

/**
 * Foto COMPLETA do banco (X-1222, K2): todas as tabelas do esquema public (contagem + md5 de todas as linhas), o valor de
 * toda sequência e o catálogo com o xmin de cada linha (classe, coluna, função com o corpo, gatilho com o estado, restrição,
 * índice). Qualquer escrita, até um CREATE OR REPLACE com o mesmo texto, muda o xmin.
 */
async function snapshot(url: string) {
  const c = await client(url)
  try {
    const tables = (await c.query(`SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map(r => r.t as string)
    const data: Record<string, string> = {}
    for (const t of tables) data[t] = (await c.query(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, E'\\n' ORDER BY x::text)), '') AS h FROM public."${t}" x`)).rows[0].h
    const seqs = (await c.query(`SELECT c.relname::text AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1`)).rows.map(r => r.s as string)
    const sequences: Record<string, string> = {}
    for (const s of seqs) sequences[s] = (await c.query(`SELECT last_value::text || ':' || is_called::text AS v FROM public."${s}"`)).rows[0].v
    const catalog = (await c.query(`
      SELECT 'class' AS k, c.relname::text AS n, c.xmin::text || ':' || c.relkind::text AS v FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public'
      UNION ALL SELECT 'column', c.relname || '.' || a.attname, a.xmin::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND a.attnum > 0
      UNION ALL SELECT 'function', p.oid::regprocedure::text, p.xmin::text || ':' || md5(p.prosrc) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public'
      UNION ALL SELECT 'trigger', c.relname || '.' || t.tgname, t.xmin::text || ':' || t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public'
      UNION ALL SELECT 'constraint', c.relname || '.' || k.conname, k.xmin::text FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public'
      UNION ALL SELECT 'index', c.relname, i.xmin::text FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public'
      ORDER BY 1, 2`)).rows.map(r => `${r.k} ${r.n} ${r.v}`)
    return { data, sequences, catalog }
  } finally { await c.end() }
}

/** Espera até `n` pedidos de trava NÃO concedidos que casam com o filtro (barreira determinística por pg_locks). */
async function waitWaiting(url: string, where: string, n: number, params: unknown[] = []) {
  const c = await client(url)
  try {
    for (let i = 0; i < 400; i++) {
      const got = Number((await c.query(`SELECT count(*)::int AS n FROM pg_locks l WHERE NOT l.granted AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND (${where})`, params)).rows[0].n)
      if (got === n) return
      if (got > n) throw new Error(`mais esperas que o previsto: ${got} > ${n}`)
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`barreira: ${n} espera(s) não apareceram`)
  } finally { await c.end() }
}
const BOOT_WAIT = `l.locktype = 'advisory' AND l.classid = 0 AND l.objid = ${BOOT_LOCK_KEY} AND l.objsubid = 1`

// ---------- bancos legados (sem perfil, com dado) ----------
type Legacy = (c: pg.Client) => Promise<void>
const MER = `INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ('mer_LEGADO', 'Legado', 'h-legado', '${TREASURY}')`
const BEN = `INSERT INTO affiliate_beneficiaries (id, merchant_id, beneficiary_ref, kind) VALUES ('ben_L', 'mer_LEGADO', 'aff_${'a'.repeat(32)}', 'affiliate')`
const COM = (quote: string, extra = '') => `INSERT INTO affiliate_commissions (id, merchant_id, beneficiary_id, source_event_id, amount_minor, created_amount_minor, usd_units, rate_num, rate_den, quote_source, quote_at, quote_hash, status, occurred_at${extra ? ', settlement_id' : ''})
  VALUES ('com_L', 'mer_LEGADO', 'ben_L', 'ar_legado', 3657, 3657, 7000000, 100000000, 52130, '${quote}', now(), 'h', 'pending', now()${extra ? `, '${extra}'` : ''})`
const STL = (id: string, chain: number, token: string, sender: string) => `INSERT INTO settlements (id, order_id, kind, beneficiary_ref, chain_id, token, sender, recipient, amount_units, memo, status, hold_reason)
  VALUES ('${id}', NULL, 'affiliate_payout', 'aff_${'a'.repeat(32)}', ${chain}, '${token}', '${sender}', '${OTHER}', 7000000, 'memo-${id}', 'intent_recorded', 'affiliate_settle_off')`
const LEGACY: Record<string, Legacy> = {
  'comissão Binance sem liquidação (tesouraria desconhecida)': async c => { await c.query(MER); await c.query(BEN); await c.query(COM('binance_usdtbrl')) },
  'comissão de cotação simulada': async c => { await c.query(MER); await c.query(BEN); await c.query(COM('simulated')) },
  'só o razão (sem comissão)': async c => {
    await c.query(MER); await c.query(BEN)
    await c.query(`INSERT INTO affiliate_ledger (beneficiary_id, kind, usd_units, ref_kind, ref_id, op_key) VALUES ('ben_L', 'adjustment', 5000000, 'manual', 'x', 'manual:x')`)
  },
  'só saque (sem comissão)': async c => {
    await c.query(MER); await c.query(BEN)
    await c.query(`INSERT INTO affiliate_quote_locks (id, beneficiary_id, kind, usd_units, rate_num, rate_den, quote_source, gross_minor, fee_minor, net_minor, expires_at) VALUES ('qlk_L', 'ben_L', 'pix', 1000000, 52130, 100000000, 'binance_usdtbrl', 521, 0, 521, now())`)
    await c.query(`INSERT INTO affiliate_withdrawals (id, beneficiary_id, kind, lock_id, usd_units, net_minor, fee_minor, status) VALUES ('wdr_L', 'ben_L', 'pix', 'qlk_L', 1000000, 521, 0, 'requested')`)
  },
  'só recibo (sem comissão nem saque)': async c => {
    await c.query(STL('stl_R', 4217, TEMPO_MAINNET_USDC, TREASURY.toLowerCase()))
    await c.query(`INSERT INTO affiliate_receipts (id, settlement_id, digest_hex, envelope) VALUES ('rct_L', 'stl_R', '${'d'.repeat(64)}', '{"payload":{"chain_id":4217}}')`)
  },
  'liquidação de outra rede': async c => { await c.query(STL('stl_C', 1, TEMPO_MAINNET_USDC, TREASURY.toLowerCase())) },
  'liquidação de outro token': async c => { await c.query(STL('stl_T', 4217, '0x20c0000000000000000000000000000000000001', TREASURY.toLowerCase())) },
  'liquidação de outra tesouraria': async c => { await c.query(STL('stl_S', 4217, TEMPO_MAINNET_USDC, OTHER.toLowerCase())) },
  'só o lojista (chave de API de outro banco)': async c => { await c.query(MER) },
  'só um beneficiário com carteira': async c => { await c.query(MER); await c.query(`INSERT INTO affiliate_beneficiaries (id, merchant_id, beneficiary_ref, kind, payout_address) VALUES ('ben_W', 'mer_LEGADO', 'aff_${'b'.repeat(32)}', 'affiliate', '${OTHER}')`) },
  'só a trilha de estados': async c => { await c.query(`INSERT INTO state_transitions (entity, entity_id, from_state, to_state, source) VALUES ('affiliate_commission', 'com_X', NULL, 'pending', 'api')`) },
}

/** Banco com as migrações de negócio aplicadas SEM a identidade da v7.4 (como a v7.2, ou um migrate solto) e o dado do cenário. */
async function legacyDb(fill: Legacy, opts: { upTo015?: boolean } = {}): Promise<string> {
  const url = await freshUrl()
  const db = createPool(url)
  try {
    if (opts.upTo015) {
      const dir = mkdtempSync(join(tmpdir(), 'pst-v72-'))
      cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
      for (const f of readdirSync(MIGRATION_DIR).filter(f => f.endsWith('.sql') && f < '016')) copyFileSync(new URL(f, MIGRATION_DIR), join(dir, f))
      await migrate(db, pathToFileURL(dir + '/'))
    } else await migrate(db)
  } finally { await db.end() }
  const c = await client(url)
  try { await fill(c) } finally { await c.end() }
  return url
}

describe('v7.3: banco preso ao perfil da instância', () => {
  it('reboot igual sobe; ensaio e produção nunca se cruzam; a política de cotação faz parte do perfil', async () => {
    const url = await freshUrl()
    const s = await startAffiliatesProduction(env(url, REHEARSAL))
    const h = await (await fetch(`http://127.0.0.1:${port(s)}/healthz`)).json()
    expect(h.database_profile).toMatchObject({ mode: 'rehearsal', quote_source: 'simulated', adopted: false })
    await s.stop()
    await boot(env(url, REHEARSAL)) // mesmo perfil sobe de novo
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_mismatch/)
    // ensaio com cotação da Binance é outro perfil: não sobe no banco de um ensaio com cotação simulada
    await expect(startAffiliatesProduction(env(url, { PRODUCTION_REHEARSAL: '1' }))).rejects.toThrow(/database_profile_mismatch/)
    expect(await profileRows(url)).toEqual([{ mode: 'rehearsal', chain_id: 4217, token: TEMPO_MAINNET_USDC, treasury: TREASURY.toLowerCase(), quote_source: 'simulated', adopted: false }])

    const url2 = await freshUrl()
    await boot(env(url2))
    await expect(startAffiliatesProduction(env(url2, REHEARSAL))).rejects.toThrow(/database_profile_mismatch/)
    expect((await profileRows(url2))[0]).toMatchObject({ mode: 'production', quote_source: 'binance_usdtbrl' })
  })

  it('outra tesouraria, outra rede ou outro token no mesmo banco é recusado; grafia do endereço não conta', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    await expect(startAffiliatesProduction(env(url, { ...REHEARSAL, TREASURY_ADDRESS: OTHER }))).rejects.toThrow(/database_profile_mismatch/)
    await expect(startAffiliatesProduction(env(url, { ...REHEARSAL, CHAIN_ID: '42431', TOKEN: '0x20c0000000000000000000000000000000000000' }))).rejects.toThrow(/database_profile_mismatch/)
    await expect(startAffiliatesProduction(env(url, { ...REHEARSAL, TOKEN: '0x20c0000000000000000000000000000000000001' }))).rejects.toThrow(/database_profile_mismatch/)
    await boot(env(url, { ...REHEARSAL, TREASURY_ADDRESS: TREASURY.toLowerCase() }))
    expect(await profileRows(url)).toHaveLength(1)
  })

  it('perfil diferente com migração de negócio pendente: recusa ANTES de migrar e o banco fica igual; o perfil certo migra', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    const db = createPool(url, { profileFingerprint: profileFingerprint(REH) }) // só quem declara o perfil mexe no banco preso
    await rollback(db, '017_affiliate_created_amount_lock.sql') // deixa uma migração de negócio pendente
    await db.end()
    const before = await snapshot(url)
    expect(await appliedMigrations(url)).not.toContain('017_affiliate_created_amount_lock.sql')
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_mismatch/)
    expect(await snapshot(url)).toEqual(before) // nada migrou, nada mudou
    expect((await q(url, `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='affiliate_created_amount_immutable'`))[0]!.n).toBe(0)
    await boot(env(url, REHEARSAL))
    expect(await appliedMigrations(url)).toContain('017_affiliate_created_amount_lock.sql')
  })

  it('banco com dado da demo não é preso, e fica igual', async () => {
    const url = await freshUrl()
    const db = createPool(url); cleanups.push(() => db.end())
    await migrate(db)
    await db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ('mer_DEMO', 'Demo', 'h', $1)`, [TREASURY])
    await db.query(`INSERT INTO orders (id, merchant_id, external_ref, amount_minor, status, expires_at, provider_env, chain_env) VALUES ('ord_1', 'mer_DEMO', 'x', 100, 'paid', now(), 'simulated', 'testnet')`)
    const before = await snapshot(url)
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_has_demo_data/)
    expect(await snapshot(url)).toEqual(before)
    expect(await profileRows(url)).toEqual([])
  })
})

/** A 016 da primeira v7.3 (8ec4b9d), byte a byte da revisão: sem quote_source e sem adopted. */
const OLD_016 = `CREATE TABLE IF NOT EXISTS instance_profile (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode       text NOT NULL CHECK (mode IN ('production', 'rehearsal')),
  chain_id   integer NOT NULL CHECK (chain_id > 0),
  token      text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  treasury   text NOT NULL CHECK (treasury ~ '^0x[0-9a-f]{40}$'),
  claimed_at timestamptz NOT NULL DEFAULT now()
);`

/** Volta um banco preso para a identidade da v7.3 corrigida (b8cc379): sem gatilho de TRUNCATE e sem a guarda. */
const TO_V73B = `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'instance_profile_write_guard' LOOP
    EXECUTE format('DROP TRIGGER instance_profile_write_guard ON public.%I', r.relname);
  END LOOP;
END $$;
DROP TRIGGER instance_profile_no_truncate ON instance_profile;
DROP FUNCTION instance_profile_guard_install(); DROP FUNCTION instance_profile_write_guard(); DROP FUNCTION instance_profile_fingerprint();`

const guardCounts = async (url: string) => (await q(url, `SELECT
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'instance_profile') AS tables,
  (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'instance_profile_write_guard' AND tgenabled <> 'D') AS guards`))[0]!
const stateOf = async (url: string) => { const db = createPool(url); try { return await identityState(db) } finally { await db.end() } }
const attempts = async (url: string) => (await q(url, `SELECT last_value::int AS v, is_called AS c FROM schema_migration_attempts`))[0]!

describe('v7.4 BANCO (X-1222): legado nunca é adotado e toda recusa é só leitura', () => {
  it('cada cenário de legado é recusado pela produção e pelo ensaio, e o banco fica igual (dado, sequências e catálogo)', async () => {
    for (const [name, fill] of Object.entries(LEGACY)) {
      const url = await legacyDb(fill)
      expect((await stateOf(url)).kind, name).toBe('upgrade') // migrate solto: tabela do perfil da 016, sem linha
      const before = await snapshot(url)
      for (const e of [env(url), env(url, REHEARSAL)]) await expect(startAffiliatesProduction(e), name).rejects.toThrow(/database_profile_missing_with_data/)
      expect(await snapshot(url), name).toEqual(before)
      expect(await profileRows(url), name).toEqual([])
    }
  }, 180_000)

  it('banco no esquema da v7.2 (até a 015, sem a tabela do perfil) e com dado: recusado sem criar nada', async () => {
    const url = await legacyDb(LEGACY['comissão Binance sem liquidação (tesouraria desconhecida)']!, { upTo015: true })
    expect(await stateOf(url)).toEqual({ kind: 'absent' })
    const before = await snapshot(url)
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_missing_with_data/)
    expect(await snapshot(url)).toEqual(before)
    expect((await q(url, `SELECT to_regclass('public.instance_profile') AS t`))[0]!.t).toBeNull()
  })

  it('não existe caminho de adoção de legado: nem função, nem comando', () => {
    expect(Object.keys(instanceProfile)).not.toContain('adoptLegacyDatabase')
    expect(existsSync(fileURLToPath(new URL('../scripts/affiliates-adopt-profile.ts', import.meta.url)))).toBe(false)
  })

  it('K6: banco com a 016 da primeira v7.3 (8ec4b9d) é recusado com código próprio, com ou sem linha, e fica igual', async () => {
    const url = await freshUrl()
    await q(url, OLD_016)
    expect(await stateOf(url)).toEqual({ kind: 'outdated', missing: ['adopted', 'quote_source'] })
    let before = await snapshot(url)
    for (const e of [env(url), env(url, REHEARSAL)]) await expect(startAffiliatesProduction(e)).rejects.toThrow(/database_profile_schema_outdated/)
    expect(await snapshot(url)).toEqual(before)
    await q(url, `INSERT INTO instance_profile (id, mode, chain_id, token, treasury) VALUES (1, 'production', 4217, $1, $2)`, [TEMPO_MAINNET_USDC, TREASURY.toLowerCase()])
    before = await snapshot(url)
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_schema_outdated/)
    expect(await snapshot(url)).toEqual(before)
  })

  it('K2: recusa por perfil diferente não escreve nada, com a identidade atual e com a da v7.3 (que o perfil certo atualiza)', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    expect(await stateOf(url)).toEqual({ kind: 'current' })
    let before = await snapshot(url)
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_mismatch/)
    expect(await snapshot(url)).toEqual(before)
    await boot(env(url, REHEARSAL)) // reboot igual também não escreve no catálogo nem nos dados
    expect(await snapshot(url)).toEqual(before)

    await q(url, TO_V73B) // banco preso pela v7.3 corrigida
    expect(await stateOf(url)).toMatchObject({ kind: 'upgrade' })
    before = await snapshot(url)
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_mismatch/)
    expect(await snapshot(url)).toEqual(before) // o perfil errado não atualiza a identidade
    await boot(env(url, REHEARSAL)) // o certo atualiza e liga a guarda nas tabelas que já existiam
    expect(await stateOf(url)).toEqual({ kind: 'current' })
    const g = await guardCounts(url)
    expect(g.guards).toBe(g.tables)
  })

  it('proteção desligada à mão (gatilho do perfil ou guarda) para o boot com código próprio, sem escrever', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    for (const [off, on] of [
      ['ALTER TABLE instance_profile DISABLE TRIGGER instance_profile_immutable', 'ALTER TABLE instance_profile ENABLE TRIGGER instance_profile_immutable'],
      ['ALTER TABLE merchants DISABLE TRIGGER instance_profile_write_guard', 'ALTER TABLE merchants ENABLE TRIGGER instance_profile_write_guard'],
    ] as const) {
      await q(url, off)
      const before = await snapshot(url)
      await expect(startAffiliatesProduction(env(url, REHEARSAL))).rejects.toThrow(/database_profile_guard_missing/)
      expect(await snapshot(url)).toEqual(before)
      await q(url, on)
    }
    await boot(env(url, REHEARSAL))
  })

  it('K5: a linha do perfil recusa UPDATE, DELETE e TRUNCATE (mesmo declarando o perfil); a volta da 016 recusa com o banco preso', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    const c = await client(url, REH)
    try {
      await expect(c.query(`UPDATE instance_profile SET mode='production', quote_source='binance_usdtbrl'`)).rejects.toThrow(/instance_profile is immutable/)
      await expect(c.query(`DELETE FROM instance_profile`)).rejects.toThrow(/instance_profile is immutable/)
      await expect(c.query(`TRUNCATE instance_profile`)).rejects.toThrow(/instance_profile is immutable/)
      await expect(c.query(`INSERT INTO instance_profile (id, mode, chain_id, token, treasury, quote_source) VALUES (1, 'production', 4217, $1, $2, 'simulated')`, [TEMPO_MAINNET_USDC, TREASURY.toLowerCase()]))
        .rejects.toThrow() // uma linha só, e produção nunca com cotação simulada
      const down = readFileSync(new URL('../migrations/down/016_instance_profile.down.sql', import.meta.url), 'utf8')
      await expect(c.query(down)).rejects.toThrow(/database profile is claimed/)
    } finally { await c.end() }
    expect(await profileRows(url)).toHaveLength(1)
  })
})

describe('v7.4 BANCO P2 (X-1222): escritor antigo, sem a trava do boot', () => {
  it('guarda de escrita: no banco preso, sessão sem o perfil (código antigo) ou com outro perfil é recusada em INSERT, UPDATE, DELETE e TRUNCATE; a certa escreve; leitura livre', async () => {
    const url = await freshUrl()
    const s = await startAffiliatesProduction(env(url, REHEARSAL)); cleanups.push(() => s.stop())
    await provisionMerchant(s.ctx.db, { id: 'mer_EQUILIBRIUM01', name: 'Equilibrium', apiKeySha256: 'a'.repeat(64), poolAddress: TREASURY }) // o pool do runtime declara
    const g = await guardCounts(url)
    expect(g.guards).toBe(g.tables) // guarda em TODA tabela do esquema public, menos a do perfil
    const legacy = await client(url), wrong = await client(url, PROD), right = await client(url, REH)
    try {
      for (const c of [legacy, wrong]) {
        await expect(c.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ('mer_X', 'X', 'h-x', $1)`, [TREASURY])).rejects.toThrow(/legacy_writer_refused: INSERT em merchants/)
        await expect(c.query(`UPDATE merchants SET name = 'X'`)).rejects.toThrow(/legacy_writer_refused: UPDATE em merchants/)
        await expect(c.query(`DELETE FROM affiliate_policies`)).rejects.toThrow(/legacy_writer_refused: DELETE em affiliate_policies/)
        await expect(c.query(`TRUNCATE affiliate_ledger`)).rejects.toThrow(/legacy_writer_refused: TRUNCATE em affiliate_ledger/)
        await expect(c.query(`INSERT INTO state_transitions (entity, entity_id, to_state, source) VALUES ('x', 'x', 'x', 'x')`)).rejects.toThrow(/legacy_writer_refused/)
        await expect(c.query(`INSERT INTO schema_migrations (name) VALUES ('999_antiga.sql')`)).rejects.toThrow(/legacy_writer_refused/)
        expect((await c.query(`SELECT count(*)::int AS n FROM merchants`)).rows[0].n).toBe(1)
      }
      await right.query(`UPDATE merchants SET name = 'Equilibrium 2' WHERE id = 'mer_EQUILIBRIUM01'`)
    } finally { for (const c of [legacy, wrong, right]) await c.end() }
    expect((await q(url, `SELECT name FROM merchants`))[0]!.name).toBe('Equilibrium 2')
  })

  it('escritor antigo com transação aberta ANTES de prender: o boot espera, vê a linha e recusa (nada preso, identidade desfeita)', async () => {
    const url = await freshUrl()
    { const db = createPool(url); await migrate(db); await db.end() } // tabelas criadas e vazias, sem perfil
    const w = await client(url)
    await w.query('BEGIN'); await w.query(MER)
    const p = startAffiliatesProduction(env(url, REHEARSAL))
    p.catch(() => undefined)
    await waitWaiting(url, `l.locktype = 'relation' AND l.relation = 'merchants'::regclass AND l.mode = 'ShareRowExclusiveLock'`, 1)
    await w.query('COMMIT'); await w.end()
    await expect(p).rejects.toThrow(/database_profile_missing_with_data/)
    expect(await profileRows(url)).toEqual([])
    expect((await stateOf(url)).kind).toBe('upgrade') // a identidade nova criada na transação foi desfeita junto
    expect((await guardCounts(url)).guards).toBe(0)
  })

  it('escritor antigo que chega DEPOIS da conferência: fica parado na trava das tabelas e, preso o banco, é recusado pela guarda', async () => {
    const url = await freshUrl()
    { const db = createPool(url); await migrate(db); await db.end() }
    // barreira: segura a última tabela da ordem de trava (state_transitions) para o boot parar com as outras já travadas
    const holder = await client(url)
    await holder.query('BEGIN'); await holder.query('LOCK TABLE public.state_transitions IN ROW EXCLUSIVE MODE')
    const p = startAffiliatesProduction(env(url, REHEARSAL))
    await waitWaiting(url, `l.locktype = 'relation' AND l.relation = 'state_transitions'::regclass AND l.mode = 'ShareRowExclusiveLock'`, 1)
    const w = await client(url)
    const ins = w.query(MER)
    ins.catch(() => undefined)
    await waitWaiting(url, `l.locktype = 'relation' AND l.relation = 'merchants'::regclass AND l.mode = 'RowExclusiveLock'`, 1)
    await holder.query('ROLLBACK'); await holder.end()
    const s = await p
    await expect(ins).rejects.toThrow(/legacy_writer_refused: INSERT em merchants/)
    await w.end(); await s.stop()
    expect((await q(url, `SELECT count(*)::int AS n FROM merchants`))[0]!.n).toBe(0)
    expect((await profileRows(url))[0]).toMatchObject({ mode: 'rehearsal' })
  })
})

describe('v7.4: a guarda nasce com a tabela', () => {
  it('num banco preso, cada migração liga a guarda nas tabelas que cria, na mesma transação (sem esperar o fim do boot)', async () => {
    const url = await freshUrl()
    const db = createPool(url, { profileFingerprint: profileFingerprint(REH) })
    try {
      await withBootLock(db, () => bindDatabaseProfile(db, REH)) // só o perfil: nenhuma tabela de negócio ainda
      expect((await guardCounts(url)).tables).toBe(0)
      await migrate(db) // sem o installWriteGuard do fim do boot
    } finally { await db.end() }
    const g = await guardCounts(url)
    expect(g.tables).toBeGreaterThan(40)
    expect(g.guards).toBe(g.tables)
    expect(await attempts(url)).toEqual({ v: MIGRATIONS, c: true })
  })
})

describe('v7.4 BOOT (X-1222)', () => {
  it('K4: dois boots completos com perfis em conflito, nas DUAS ordens forçadas pela fila da trava: cada migração tentada uma vez e o perdedor não muda nada', async () => {
    const orders: Array<[string, (u: string) => Record<string, string | undefined>, (u: string) => Record<string, string | undefined>]> = [
      ['ensaio primeiro', u => env(u, REHEARSAL), u => env(u)],
      ['produção primeiro', u => env(u), u => env(u, REHEARSAL)],
    ]
    for (const [name, first, second] of orders) {
      const url = await freshUrl()
      const gate = await client(url)
      await gate.query('SELECT pg_advisory_lock($1)', [BOOT_LOCK_KEY])
      const done: string[] = []
      const pA = startAffiliatesProduction(first(url)).then(s => { done.push('A subiu'); return s }, e => { done.push('A recusado'); throw e })
      await waitWaiting(url, BOOT_WAIT, 1)
      const mid = await client(url)
      const midLocked = mid.query('SELECT pg_advisory_lock($1)', [BOOT_LOCK_KEY]) // barreira entre os dois boots
      await waitWaiting(url, BOOT_WAIT, 2)
      const pB = startAffiliatesProduction(second(url)).then(s => { done.push('B subiu'); return s }, e => { done.push('B recusado'); throw e })
      pB.catch(() => undefined)
      await waitWaiting(url, BOOT_WAIT, 3)
      await gate.query('SELECT pg_advisory_unlock($1)', [BOOT_LOCK_KEY]); await gate.end()
      const a = await pA
      await midLocked
      expect(await attempts(url), name).toEqual({ v: MIGRATIONS, c: true }) // cada migração tentada uma vez
      expect(await appliedMigrations(url), name).toHaveLength(MIGRATIONS)
      const between = await snapshot(url)
      await mid.query('SELECT pg_advisory_unlock($1)', [BOOT_LOCK_KEY]); await mid.end()
      await expect(pB, name).rejects.toThrow(/database_profile_mismatch/)
      expect(await snapshot(url), name).toEqual(between) // o perdedor não escreveu nada (dado, sequência das tentativas, catálogo)
      expect(done, name).toEqual(['A subiu', 'B recusado'])
      expect((await profileRows(url))[0]!.mode, name).toBe(a.cfg.rehearsal ? 'rehearsal' : 'production')
      await a.stop()
    }
  }, 120_000)

  it('K1: a fase pública não toca na chave; com banco de outro perfil a recusa vem sem nenhuma leitura de chave, e no banco certo a chave só é lida depois do preflight', async () => {
    const addr = privateKeyToAccount(TREASURY_KEY).address
    const watch = (raw: Record<string, string | undefined>, reads: string[], phase: () => string) => new Proxy(raw, {
      get(t, k) { if (k === 'TREASURY_KEY' || k === 'ISSUER_KEY') reads.push(`${String(k)}:${phase()}`); return Reflect.get(t, k) },
    })
    const url = await freshUrl()
    await boot(env(url, REHEARSAL)) // banco de outro perfil
    const reads: string[] = []
    const raw = env(url, { AFFILIATE_SETTLE: '1', TREASURY_KEY, ISSUER_KEY, TREASURY_ADDRESS: addr, TOKEN: TEMPO_MAINNET_USDC })
    expect(publicLaunchPlan(watch(raw, reads, () => 'fase pública')).profile).toMatchObject({ mode: 'production', treasury: addr })
    expect(reads).toEqual([])
    await expect(prepareLaunch(watch(raw, reads, () => 'antes do banco'))).rejects.toThrow(/database_profile_mismatch/)
    expect(reads).toEqual([])

    const url2 = await freshUrl()
    let checked = false
    const reads2: string[] = []
    const plan = await prepareLaunch(watch({ ...raw, DATABASE_URL: url2 }, reads2, () => (checked ? 'depois do banco' : 'antes do banco')), async pub => { const b = await preflightDatabase(pub); checked = true; return b })
    expect(reads2.length).toBeGreaterThan(0)
    expect(reads2.every(r => r.endsWith('depois do banco')), reads2.join(',')).toBe(true)
    expect(plan.signer).toMatchObject({ TREASURY_KEY, ISSUER_KEY })
    expect((await profileRows(url2))[0]).toMatchObject({ mode: 'production', treasury: addr.toLowerCase() })
  })
})

/** Lê o censo do processo (uma linha JSON por evento). */
const readAudit = (file: string): Array<Record<string, any>> => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const auditFile = () => { const f = join(tmpdir(), `pst-audit-${randomUUID()}.jsonl`); cleanups.push(async () => rmSync(f, { force: true })); return f }
const BASE = () => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' })
/** Nada vivo na saída além dos canos de stdio: nenhum filho, nenhum servidor, nenhum socket, nenhum temporizador do worker. */
const ALIVE = /ProcessWrap|TCPServerWrap|TCPWrap|Timeout|Immediate|Interval/

/** Sobe um processo de verdade com o censo, espera `ready` na saída, encerra com SIGTERM e devolve os eventos. */
async function runUntil(args: string[], e: Record<string, string>, ready: RegExp): Promise<{ events: Array<Record<string, any>>; out: string }> {
  const file = auditFile()
  const child = spawn(process.execPath, ['--import', AUDIT, '--import', 'tsx', ...args], { env: { ...e, PIXSETTLE_PROCESS_AUDIT: file }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const exited = new Promise<void>(res => child.on('exit', () => res()))
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`não ficou pronto: ${out}`)), 60_000)
    const on = (d: Buffer) => { out += d.toString(); if (ready.test(out)) { clearTimeout(t); res() } }
    child.stdout.on('data', on); child.stderr.on('data', on)
  })
  child.kill('SIGTERM')
  await exited
  return { events: readAudit(file), out }
}

describe('v7.4 K3 (X-1222): censo real do processo nas recusas', () => {
  it('o launcher recusa banco de outro perfil antes de ler a chave e sem subir nada: nenhum filho, nenhum servidor, nada vivo na saída; chave inválida não muda o motivo', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    const before = await snapshot(url)
    const addr = privateKeyToAccount(TREASURY_KEY).address
    const cases: Record<string, Record<string, string>> = {
      'com assinante e chaves válidas': { ...BASE(), ...env(url, { AFFILIATE_SETTLE: '1', TREASURY_KEY, ISSUER_KEY, TREASURY_ADDRESS: addr, TOKEN: TEMPO_MAINNET_USDC, SETTLEMENT_PORT: '7997' }) } as Record<string, string>,
      'com assinante e chave INVÁLIDA': { ...BASE(), ...env(url, { AFFILIATE_SETTLE: '1', TREASURY_KEY: '0xnao-e-chave', ISSUER_KEY: '0x12', TREASURY_ADDRESS: addr, TOKEN: TEMPO_MAINNET_USDC, SETTLEMENT_PORT: '7996' }) } as Record<string, string>,
      'só o core': { ...BASE(), ...env(url) } as Record<string, string>,
    }
    for (const [name, e] of Object.entries(cases)) {
      const file = auditFile()
      const r = spawnSync(process.execPath, ['--import', AUDIT, '--import', 'tsx', LAUNCHER], { env: { ...e, PIXSETTLE_PROCESS_AUDIT: file }, encoding: 'utf8', timeout: 60_000 })
      expect(r.status, name).toBe(1)
      expect(r.stderr, name).toMatch(/database_profile_mismatch/) // K1: o banco decide antes de a chave ser lida (a inválida nem é vista)
      expect(r.stderr + r.stdout, name).not.toMatch(/signer_key_invalid|key_address_mismatch|saiu|ouvindo/)
      for (const k of [TREASURY_KEY, ISSUER_KEY]) expect(r.stderr + r.stdout, name).not.toContain(k.slice(2))
      const ev = readAudit(file)
      expect(ev.map(x => x.ev), name).toEqual(['start', 'exit'])
      expect(ev.filter(x => x.ev === 'child' || x.ev === 'listen'), name).toEqual([])
      const exit = ev.find(x => x.ev === 'exit')!
      expect(exit.code, name).toBe(1)
      expect((exit.resources as string[]).filter(x => ALIVE.test(x)), name).toEqual([])
    }
    expect(await snapshot(url)).toEqual(before)
  }, 120_000)

  it('o core recusado direto não abre servidor, worker nem filho; controle: o mesmo censo vê o servidor do core e o filho do launcher quando sobem', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    const file = auditFile()
    const r = spawnSync(process.execPath, ['--import', AUDIT, '--import', 'tsx', CORE], { env: { ...BASE(), ...env(url), PIXSETTLE_PROCESS_AUDIT: file } as Record<string, string>, encoding: 'utf8', timeout: 60_000 })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/database_profile_mismatch/)
    const ev = readAudit(file)
    expect(ev.map(x => x.ev)).toEqual(['start', 'exit'])
    expect((ev[1]!.resources as string[]).filter(x => ALIVE.test(x))).toEqual([])
    // controles (o censo enxerga o que conta): o core do perfil certo ouve; o launcher do perfil certo cria o filho do core
    const core = await runUntil([CORE], { ...BASE(), ...env(url, REHEARSAL) } as Record<string, string>, /ouvindo/)
    expect(core.events.filter(x => x.ev === 'listen')).toHaveLength(1)
    const launcher = await runUntil([LAUNCHER], { ...BASE(), ...env(url, REHEARSAL) } as Record<string, string>, /ouvindo/)
    const kids = launcher.events.filter(x => x.ev === 'child')
    expect(kids).toHaveLength(1)
    expect(kids[0]!.args).toContain('src/affiliates/production.ts')
    expect(JSON.stringify(launcher.events)).not.toMatch(/TREASURY_KEY|ISSUER_KEY/) // o censo nunca grava o ambiente do filho
  }, 120_000)
})

describe('v7.4: o cadastro do lojista não migra nem prende', () => {
  it('exige o banco preso ao perfil do ambiente, com a identidade atual e sem migração pendente; escreve declarando o perfil', async () => {
    const script = fileURLToPath(new URL('../scripts/affiliates-merchant.ts', import.meta.url))
    const args = ['--import', 'tsx', script, '--id', 'mer_EQUILIBRIUM01', '--name', 'Equilibrium', '--key-sha256', 'a'.repeat(64), '--pool', TREASURY]
    const run = (e: Record<string, string | undefined>) => spawnSync(process.execPath, args, { env: { ...BASE(), ...e } as Record<string, string>, encoding: 'utf8', timeout: 60_000 })
    const url = await freshUrl()
    let r = run(env(url, REHEARSAL)) // banco novo: recusa, não prende e não migra
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/database_not_ready/)
    expect((await q(url, `SELECT to_regclass('public.merchants') AS m, to_regclass('public.instance_profile') AS p`))[0]).toEqual({ m: null, p: null })
    await boot(env(url, REHEARSAL))
    r = run(env(url)) // ambiente de outro perfil
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/database_profile_mismatch/)
    r = run(env(url, REHEARSAL))
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, merchant_id: 'mer_EQUILIBRIUM01', created: true })
    const db = createPool(url, { profileFingerprint: profileFingerprint(REH) })
    await rollback(db, '017_affiliate_created_amount_lock.sql'); await db.end()
    r = run(env(url, REHEARSAL)) // migração pendente: só o boot migra
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/database_not_ready.*017_affiliate_created_amount_lock/)
    // e o migrate solto também recusa o banco preso (as migrações rodam só no boot, sob a trava e com o perfil declarado)
    const m = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/migrate.ts', import.meta.url))], { env: { ...BASE(), DATABASE_URL: url } as Record<string, string>, encoding: 'utf8', timeout: 60_000 })
    expect(m.status).toBe(1); expect(m.stderr).toMatch(/database_bound/)
    expect(await appliedMigrations(url)).not.toContain('017_affiliate_created_amount_lock.sql')
  }, 120_000)
})
