// v7.3 (10/10/2026; revisões X-1211 e X-1212): o banco da produção dos afiliados fica preso a um perfil (modo, rede, token,
// tesouraria e política de cotação) ANTES das migrações de negócio, de qualquer escrita e de qualquer processo com chave.
// Ensaio nunca escreve no banco da produção, a produção nunca sobe no banco de um ensaio, e banco legado só entra por
// adoção explícita, validada e auditada.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { privateKeyToAccount } from 'viem/accounts'
import { startAffiliatesProduction, TEMPO_MAINNET_USDC } from '../src/affiliates/production.js'
import { bindDatabaseProfile, adoptLegacyDatabase, withBootLock, type InstanceProfile } from '../src/affiliates/instance-profile.js'
import { createPool } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { rollback } from '../src/rollback.js'
import { parseAdoptArgs } from '../scripts/affiliates-adopt-profile.js'

const ADMIN = process.env.TEST_DATABASE_ADMIN ?? 'postgres://pixsettle@localhost:5433/postgres?host=/tmp'
const TREASURY = '0xb2d7d888E8415F076A3BA4215F0686810a510265'
const OTHER = '0x0F39B346693C26618157b8FC2430f6F93660fDAf'
const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).length
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

async function q(url: string, sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url }); await c.connect()
  try { return (await c.query(sql, params)).rows } finally { await c.end() }
}
const profileRows = (url: string) => q(url, 'SELECT mode, chain_id, token, treasury, quote_source, adopted FROM instance_profile')
const appliedMigrations = async (url: string) => (await q(url, `SELECT name FROM schema_migrations ORDER BY name`)).map(r => r.name as string)
async function boot(e: Record<string, string | undefined>) { const s = await startAffiliatesProduction(e); await s.stop() }

/** Banco no estado de uma v7.2 (todas as migrações, sem perfil) com uma comissão de cotação simulada e sem pedidos. */
async function legacyDb(): Promise<string> {
  const url = await freshUrl()
  const db = createPool(url)
  try {
    await migrate(db)
    await db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ('mer_LEGADO', 'Legado', 'h-legado', $1)`, [TREASURY])
    await db.query(`INSERT INTO affiliate_beneficiaries (id, merchant_id, beneficiary_ref, kind) VALUES ('ben_L', 'mer_LEGADO', $1, 'affiliate')`, ['aff_' + 'a'.repeat(32)])
    await db.query(`INSERT INTO affiliate_commissions (id, merchant_id, beneficiary_id, source_event_id, amount_minor, created_amount_minor, usd_units, rate_num, rate_den, quote_source, quote_at, quote_hash, status, occurred_at)
      VALUES ('com_L', 'mer_LEGADO', 'ben_L', 'ar_legado', 3657, 3657, 7000000, 100000000, 52130, 'simulated', now(), 'h', 'pending', now())`)
  } finally { await db.end() }
  return url
}

describe('v7.3: banco preso ao perfil da instância', () => {
  it('reboot igual sobe; ensaio e produção nunca se cruzam; a política de cotação faz parte do perfil', async () => {
    const url = await freshUrl()
    const s = await startAffiliatesProduction(env(url, REHEARSAL))
    const h = await (await fetch(`http://127.0.0.1:${(s.app.server.address() as { port: number }).port}/healthz`)).json()
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

  it('boots completos ao mesmo tempo com perfis conflitantes: um prende e migra, o outro é recusado sem efeito', async () => {
    const url = await freshUrl()
    const r = await Promise.allSettled([startAffiliatesProduction(env(url, REHEARSAL)), startAffiliatesProduction(env(url))])
    const up = r.filter(x => x.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof startAffiliatesProduction>>>[]
    expect(up).toHaveLength(1)
    const winner = up[0]!.value
    const lost = r.find(x => x.status === 'rejected') as PromiseRejectedResult
    expect(String(lost.reason)).toMatch(/database_profile_mismatch/)
    await winner.stop()
    expect(await profileRows(url)).toHaveLength(1)
    expect((await profileRows(url))[0]!.mode).toBe(winner.cfg.rehearsal ? 'rehearsal' : 'production')
    expect(await appliedMigrations(url)).toHaveLength(MIGRATIONS) // cada migração aplicada uma vez
  })

  it('banco legado com afiliados e sem pedidos nunca é adotado em silêncio; a adoção explícita valida e audita', async () => {
    const url = await legacyDb()
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_missing_with_data/)
    await expect(startAffiliatesProduction(env(url, REHEARSAL))).rejects.toThrow(/database_profile_missing_with_data/)
    expect(await profileRows(url)).toEqual([])

    const db = createPool(url); cleanups.push(() => db.end())
    const by = { operator: 'rafael', note: 'banco do ensaio de 10/10 com a comissão de teste' }
    await expect(withBootLock(db, () => adoptLegacyDatabase(db, PROD, by))).rejects.toThrow(/legacy_data_incompatible.*cotação simulada/)
    await expect(withBootLock(db, () => adoptLegacyDatabase(db, { ...REH, quoteSource: 'binance_usdtbrl' }, by))).rejects.toThrow(/legacy_data_incompatible/)
    await expect(withBootLock(db, () => adoptLegacyDatabase(db, REH, { operator: 'rafael', note: 'curta' }))).rejects.toThrow(/invalid_note/)
    expect(await profileRows(url)).toEqual([])
    const adopted = await withBootLock(db, () => adoptLegacyDatabase(db, REH, by))
    expect(adopted).toMatchObject({ mode: 'rehearsal', adopted: true, counts: { affiliate_commissions: 1 } })
    const audit = await q(url, `SELECT reason FROM state_transitions WHERE entity='instance_profile' AND to_state='adopted'`)
    expect(audit).toHaveLength(1)
    expect(JSON.parse(audit[0]!.reason)).toMatchObject({ operator: 'rafael', counts: { affiliate_commissions: 1 }, profile: { mode: 'rehearsal', quoteSource: 'simulated' } })
    await expect(withBootLock(db, () => adoptLegacyDatabase(db, REH, by))).rejects.toThrow(/database_profile_exists/)

    const s = await startAffiliatesProduction(env(url, REHEARSAL))
    expect((await (await fetch(`http://127.0.0.1:${(s.app.server.address() as { port: number }).port}/healthz`)).json()).database_profile.adopted).toBe(true)
    await s.stop()
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_mismatch/)
  })

  it('perfil diferente com migração de negócio pendente: recusa ANTES de migrar; o perfil certo migra', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    const db = createPool(url)
    await rollback(db, '017_affiliate_created_amount_lock.sql') // deixa uma migração de negócio pendente
    await db.end()
    const before = await appliedMigrations(url)
    expect(before).not.toContain('017_affiliate_created_amount_lock.sql')
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_mismatch/)
    expect(await appliedMigrations(url)).toEqual(before) // nada migrou
    expect((await q(url, `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='affiliate_created_amount_immutable'`))[0]!.n).toBe(0)
    await boot(env(url, REHEARSAL))
    expect(await appliedMigrations(url)).toContain('017_affiliate_created_amount_lock.sql')
  })

  it('banco com dado da demo não é reivindicado', async () => {
    const url = await freshUrl()
    const db = createPool(url); cleanups.push(() => db.end())
    await migrate(db)
    await db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ('mer_DEMO', 'Demo', 'h', $1)`, [TREASURY])
    await db.query(`INSERT INTO orders (id, merchant_id, external_ref, amount_minor, status, expires_at, provider_env, chain_env) VALUES ('ord_1', 'mer_DEMO', 'x', 100, 'paid', now(), 'simulated', 'testnet')`)
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_has_demo_data/)
    await expect(withBootLock(db, () => adoptLegacyDatabase(db, PROD, { operator: 'rafael', note: 'tentativa de adotar a demo' }))).rejects.toThrow(/database_has_demo_data/)
    expect(await profileRows(url)).toEqual([])
  })

  it('a linha do perfil é imutável e a volta da 016 recusa com o banco preso', async () => {
    const url = await freshUrl()
    const db = createPool(url); cleanups.push(() => db.end())
    await withBootLock(db, () => bindDatabaseProfile(db, REH))
    await expect(db.query(`UPDATE instance_profile SET mode='production', quote_source='binance_usdtbrl'`)).rejects.toThrow(/instance_profile is immutable/)
    await expect(db.query(`DELETE FROM instance_profile`)).rejects.toThrow(/instance_profile is immutable/)
    await expect(db.query(`INSERT INTO instance_profile (id, mode, chain_id, token, treasury, quote_source) VALUES (1, 'production', 4217, $1, $2, 'simulated')`, [TEMPO_MAINNET_USDC, TREASURY.toLowerCase()]))
      .rejects.toThrow() // uma linha só, e produção nunca com cotação simulada
    await migrate(db)
    const down = readFileSync(new URL('../migrations/down/016_instance_profile.down.sql', import.meta.url), 'utf8')
    await expect(db.query(down)).rejects.toThrow(/database profile is claimed/)
    expect(await profileRows(url)).toHaveLength(1)
  })

  it('o launcher recusa banco de outro perfil antes de subir qualquer filho (com e sem assinante)', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    const before = { migrations: await appliedMigrations(url), profile: await profileRows(url), commissions: (await q(url, 'SELECT count(*)::int AS n FROM affiliate_commissions'))[0]!.n }
    const script = fileURLToPath(new URL('../scripts/start-production.ts', import.meta.url))
    const TREASURY_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // chave pública de TESTE
    const ISSUER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' // chave pública de TESTE
    const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
    const withSigner = { ...base, ...env(url, { AFFILIATE_SETTLE: '1', TREASURY_KEY, ISSUER_KEY, TREASURY_ADDRESS: privateKeyToAccount(TREASURY_KEY).address, TOKEN: TEMPO_MAINNET_USDC, SETTLEMENT_PORT: '7997' }) } as Record<string, string>
    const coreOnly = { ...base, ...env(url) } as Record<string, string>
    for (const e of [withSigner, coreOnly]) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', script], { env: e, encoding: 'utf8', timeout: 60_000 })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/database_profile_mismatch/)
      expect(r.stderr + r.stdout).not.toMatch(/saiu|ouvindo/) // nenhum filho subiu (assinante ou core)
      expect(r.stderr + r.stdout).not.toContain(TREASURY_KEY.slice(2))
    }
    expect({ migrations: await appliedMigrations(url), profile: await profileRows(url), commissions: (await q(url, 'SELECT count(*)::int AS n FROM affiliate_commissions'))[0]!.n }).toEqual(before)
  })

  it('a adoção pela linha de comando exige confirmação e parâmetros válidos', () => {
    const ok = ['--mode', 'rehearsal', '--chain', '4217', '--token', TEMPO_MAINNET_USDC, '--treasury', TREASURY, '--quote', 'simulated', '--operator', 'rafael', '--note', 'banco do ensaio de 10/10', '--confirm-legacy']
    expect(parseAdoptArgs(ok).profile).toMatchObject({ mode: 'rehearsal', chainId: 4217, quoteSource: 'simulated' })
    expect(() => parseAdoptArgs(ok.filter(a => a !== '--confirm-legacy'))).toThrow(/confirm_missing/)
    expect(() => parseAdoptArgs(ok.map(a => (a === 'rehearsal' ? 'production' : a)))).toThrow(/produção só com binance_usdtbrl/)
    expect(() => parseAdoptArgs(ok.map(a => (a === TREASURY ? '0x123' : a)))).toThrow(/invalid_address/)
  })
})
