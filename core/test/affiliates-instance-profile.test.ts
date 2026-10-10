// v7.3 (10/10/2026): o banco da produção dos afiliados fica preso a um perfil (modo, rede, token, tesouraria) no primeiro
// boot. Ensaio com cotação simulada nunca escreve no banco da produção, e a produção nunca sobe no banco de um ensaio.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { startAffiliatesProduction, TEMPO_MAINNET_USDC } from '../src/affiliates/production.js'
import { claimDatabaseProfile, type InstanceProfile } from '../src/affiliates/instance-profile.js'
import { createPool } from '../src/db.js'
import { migrate } from '../src/migrate.js'

const ADMIN = process.env.TEST_DATABASE_ADMIN ?? 'postgres://pixsettle@localhost:5433/postgres?host=/tmp'
const TREASURY = '0xb2d7d888E8415F076A3BA4215F0686810a510265'
const OTHER = '0x0F39B346693C26618157b8FC2430f6F93660fDAf'
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

async function rows(url: string) {
  const c = new pg.Client({ connectionString: url }); await c.connect()
  try { return (await c.query('SELECT mode, chain_id, token, treasury FROM instance_profile')).rows } finally { await c.end() }
}
async function boot(e: Record<string, string | undefined>) { const s = await startAffiliatesProduction(e); await s.stop(); return s }

describe('v7.3: banco preso ao perfil da instância', () => {
  it('o ensaio prende o banco; a produção real no mesmo banco é recusada, e o contrário também', async () => {
    const url = await freshUrl()
    const s = await startAffiliatesProduction(env(url, REHEARSAL))
    const h = await (await fetch(`http://127.0.0.1:${(s.app.server.address() as { port: number }).port}/healthz`)).json()
    expect(h.database_profile.mode).toBe('rehearsal')
    await s.stop()
    await boot(env(url, REHEARSAL)) // mesmo perfil sobe de novo
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_profile_mismatch/)
    expect(await rows(url)).toEqual([{ mode: 'rehearsal', chain_id: 4217, token: TEMPO_MAINNET_USDC, treasury: TREASURY.toLowerCase() }])

    const url2 = await freshUrl()
    await boot(env(url2))
    await expect(startAffiliatesProduction(env(url2, REHEARSAL))).rejects.toThrow(/database_profile_mismatch/)
    expect((await rows(url2))[0].mode).toBe('production')
  })

  it('outra tesouraria ou outra rede no mesmo banco é recusada', async () => {
    const url = await freshUrl()
    await boot(env(url, REHEARSAL))
    await expect(startAffiliatesProduction(env(url, { ...REHEARSAL, TREASURY_ADDRESS: OTHER }))).rejects.toThrow(/database_profile_mismatch/)
    await expect(startAffiliatesProduction(env(url, { ...REHEARSAL, CHAIN_ID: '42431', TOKEN: '0x20c0000000000000000000000000000000000000' }))).rejects.toThrow(/database_profile_mismatch/)
    await boot(env(url, { ...REHEARSAL, TREASURY_ADDRESS: TREASURY.toLowerCase() })) // só a grafia do endereço mudou: mesmo perfil
    expect(await rows(url)).toHaveLength(1)
  })

  it('banco com pedidos (dados da demo) não é reivindicado', async () => {
    const url = await freshUrl()
    const db = createPool(url); cleanups.push(() => db.end())
    await migrate(db)
    await db.query(`INSERT INTO merchants (id, name, api_key_hash, payout_address) VALUES ('mer_DEMO', 'Demo', 'h', $1)`, [TREASURY])
    await db.query(`INSERT INTO orders (id, merchant_id, external_ref, amount_minor, status, expires_at, provider_env, chain_env) VALUES ('ord_1', 'mer_DEMO', 'x', 100, 'paid', now(), 'simulated', 'testnet')`)
    await expect(startAffiliatesProduction(env(url))).rejects.toThrow(/database_has_demo_data/)
    expect(await rows(url)).toEqual([])
  })

  it('dois boots ao mesmo tempo com perfis diferentes: um prende, o outro é recusado', async () => {
    const url = await freshUrl()
    const db1 = createPool(url), db2 = createPool(url)
    cleanups.push(() => db1.end(), () => db2.end())
    await migrate(db1)
    const prod: InstanceProfile = { mode: 'production', chainId: 4217, token: TEMPO_MAINNET_USDC, treasury: TREASURY }
    const r = await Promise.allSettled([claimDatabaseProfile(db1, prod), claimDatabaseProfile(db2, { ...prod, mode: 'rehearsal' })])
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    const lost = r.find(x => x.status === 'rejected') as PromiseRejectedResult
    expect(String(lost.reason)).toMatch(/database_profile_mismatch/)
    expect(await rows(url)).toHaveLength(1)
  })

  it('a volta da 016 recusa com o banco preso e volta com o banco livre', async () => {
    const url = await freshUrl()
    const db = createPool(url); cleanups.push(() => db.end())
    await migrate(db)
    const down = readFileSync(new URL('../migrations/down/016_instance_profile.down.sql', import.meta.url), 'utf8')
    await claimDatabaseProfile(db, { mode: 'rehearsal', chainId: 4217, token: TEMPO_MAINNET_USDC, treasury: TREASURY })
    await expect(db.query(down)).rejects.toThrow(/database profile is claimed/)
    expect(await rows(url)).toHaveLength(1)
    const url2 = await freshUrl()
    const db2 = createPool(url2); cleanups.push(() => db2.end())
    await migrate(db2)
    await db2.query(down)
    expect((await db2.query(`SELECT to_regclass('public.instance_profile') AS t`)).rows[0].t).toBeNull()
  })
})
