// Instância de PRODUÇÃO dos afiliados (dinheiro real): configuração que recusa ambiguidade, tesouraria só com endereço,
// lojista cadastrado pelo hash da chave, launcher que nunca entrega chave ao core e recusa chave de outra tesouraria.
import { describe, it, expect, afterEach } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { privateKeyToAccount } from 'viem/accounts'
import { productionConfigFromEnv, startAffiliatesProduction, AddressOnlyChainGateway, TEMPO_MAINNET_USDC, ProductionConfigError } from '../src/affiliates/production.js'
import { provisionMerchant } from '../src/affiliates/merchant-provision.js'
import { createPool } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { productionLaunchPlan } from '../scripts/start-production.js'

const ADMIN = process.env.TEST_DATABASE_ADMIN ?? 'postgres://pixsettle@localhost:5433/postgres?host=/tmp'
const TREASURY = '0xb2d7d888E8415F076A3BA4215F0686810a510265'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

async function freshUrl(): Promise<string> {
  const name = 'pst_' + randomUUID().replace(/-/g, '').slice(0, 16)
  const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end()
  cleanups.push(async () => { const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE ${name} WITH (FORCE)`); await a.end() })
  const u = new URL(ADMIN); u.pathname = `/${name}`
  return u.toString()
}

const base = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  PIXSETTLE_PROFILE: 'affiliates_production', CHAIN_ID: '4217', TREASURY_ADDRESS: TREASURY, DATABASE_URL: 'postgres://x', AFFILIATE_QUOTE_SOURCE: 'binance_usdtbrl', ...over,
})

describe('produção dos afiliados: configuração', () => {
  it('mainnet com USDC da Tempo por padrão, liquidação desligada, sem assinante', () => {
    const c = productionConfigFromEnv(base({ AFFILIATE_LAUNCH_QUOTE: '1' }))
    expect(c).toMatchObject({ chainId: 4217, token: TEMPO_MAINNET_USDC, treasury: TREASURY, settle: false, settlement: null, launchQuote: true })
  })

  it('recusa no boot, com código, toda configuração ambígua', () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ PIXSETTLE_PROFILE: undefined }, 'profile_missing'],
      [{ DEMO_MODE: '1' }, 'demo_mode_forbidden'],
      [{ PIXSETTLE_SEED: 'x'.repeat(40) }, 'seed_forbidden'],
      [{ TREASURY_KEY: '0xabc' }, 'key_in_core_forbidden'],
      [{ AFFILIATE_PUBLIC_MERCHANT_ID: 'mer_x' }, 'public_read_forbidden'],
      [{ AFFILIATE_STREAMS_JSON: '{}' }, 'producer_batches_forbidden'],
      [{ AFFILIATE_KEY_SRC1: 'k' }, 'producer_batches_forbidden'],
      [{ CHAIN_ID: undefined }, 'chain_id_invalid'],
      [{ CHAIN_ID: '42431' }, 'chain_id_invalid'],
      [{ TREASURY_ADDRESS: undefined }, 'treasury_address_invalid'],
      [{ TREASURY_ADDRESS: '0x0000000000000000000000000000000000000000' }, 'treasury_address_invalid'],
      [{ TOKEN: '0x1234' }, 'token_invalid'],
      [{ DATABASE_URL: undefined }, 'database_url_missing'],
      [{ AFFILIATE_QUOTE_SOURCE: 'simulated' }, 'quote_source_invalid'],
      [{ AFFILIATE_SETTLE: '1' }, 'signer_missing'],
      [{ AFFILIATE_SETTLE: '1', SETTLEMENT_URL: 'http://127.0.0.1:7401', SETTLEMENT_HMAC_SECRET: 'h'.repeat(64) }, 'issuer_address_missing'],
    ]
    for (const [over, code] of cases) {
      let got: unknown = null
      try { productionConfigFromEnv(base(over)) } catch (e) { got = e }
      expect(got, JSON.stringify(over)).toBeInstanceOf(ProductionConfigError)
      expect((got as ProductionConfigError).code, JSON.stringify(over)).toBe(code)
    }
    // ensaio: testnet e cotação simulada só com PRODUCTION_REHEARSAL=1
    expect(productionConfigFromEnv(base({ CHAIN_ID: '42431', TOKEN: '0x20c0000000000000000000000000000000000000', AFFILIATE_QUOTE_SOURCE: 'simulated', PRODUCTION_REHEARSAL: '1' })).chainId).toBe(42431)
  })

  it('a tesouraria só com endereço nunca assina', async () => {
    const g = new AddressOnlyChainGateway(4217, TEMPO_MAINNET_USDC, TREASURY)
    expect(g.treasury).toBe(TREASURY)
    await expect(g.pendingNonce()).rejects.toThrow(/signer_absent/)
    await expect(g.signReceipt({})).rejects.toThrow(/signer_absent/)
  })
})

describe('produção dos afiliados: lojista pelo hash da chave', () => {
  it('cadastra e atualiza sem nunca ver a chave; recusa hash cru, endereço zero e hash de outro lojista', async () => {
    const db = createPool(await freshUrl()); cleanups.push(() => db.end())
    await migrate(db)
    const key = 'key-' + randomUUID()
    const hash = createHash('sha256').update(key).digest('hex')
    const r = await provisionMerchant(db, { id: 'mer_EQUILIBRIUM01', name: 'Equilibrium', apiKeySha256: hash, poolAddress: TREASURY })
    expect(r).toEqual({ id: 'mer_EQUILIBRIUM01', created: true })
    expect((await provisionMerchant(db, { id: 'mer_EQUILIBRIUM01', name: 'Equilibrium Loja', apiKeySha256: hash, poolAddress: TREASURY })).created).toBe(false)
    const m = (await db.query(`SELECT name, api_key_hash FROM merchants WHERE id='mer_EQUILIBRIUM01'`)).rows[0]
    expect(m).toEqual({ name: 'Equilibrium Loja', api_key_hash: hash })
    expect((await db.query(`SELECT pool_address FROM affiliate_policies WHERE merchant_id='mer_EQUILIBRIUM01'`)).rows[0].pool_address).toBe(TREASURY)
    await expect(provisionMerchant(db, { name: 'Xx', apiKeySha256: key, poolAddress: TREASURY })).rejects.toThrow(/invalid_key_hash/)
    await expect(provisionMerchant(db, { name: 'Outra', apiKeySha256: createHash('sha256').update('k2').digest('hex'), poolAddress: '0x0000000000000000000000000000000000000000' })).rejects.toThrow(/invalid_pool_address/)
    await expect(provisionMerchant(db, { id: 'mer_OUTRA000001', name: 'Outra', apiKeySha256: hash, poolAddress: TREASURY })).rejects.toThrow(/key_hash_in_use/)
  })
})

describe('produção dos afiliados: de ponta a ponta pelo HTTP (ensaio com cotação simulada)', () => {
  it('sobe sem chave, mostra a saúde sem segredo, aceita o lançamento, libera sem liquidar e não expõe leitura pública nem lotes', async () => {
    const url = await freshUrl()
    const s = await startAffiliatesProduction(base({ DATABASE_URL: url, AFFILIATE_QUOTE_SOURCE: 'simulated', AFFILIATE_SIM_PRICE4: '52130', PRODUCTION_REHEARSAL: '1', AFFILIATE_LAUNCH_QUOTE: '1', PORT: '0', HOST: '127.0.0.1' }))
    cleanups.push(() => s.stop())
    const addr = s.app.server.address() as { port: number }
    const at = `http://127.0.0.1:${addr.port}`
    const key = 'key-' + randomUUID()
    await provisionMerchant(s.ctx.db, { id: 'mer_EQUILIBRIUM01', name: 'Equilibrium', apiKeySha256: createHash('sha256').update(key).digest('hex'), poolAddress: TREASURY })
    const H = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }

    const h = await (await fetch(`${at}/healthz`)).json()
    expect(h).toMatchObject({ ok: true, profile: 'affiliates_production', chain_id: 4217, token: TEMPO_MAINNET_USDC, treasury: TREASURY, settle: false, launch_quote: true, capabilities: ['launch_quote'] })
    expect(JSON.stringify(h)).not.toMatch(/key|secret|seed/i)

    const quote = { mode: 'launch', rate_num: 39_884_516, rate_den: 20_848, source: 'conversao_real', at: new Date(Date.now() - 600_000).toISOString(), evidence: { brl_paid_minor: 20_848, usd_units_received: 39_884_516, tx: ['0x' + 'ab'.repeat(32)] } }
    const body = { source_event_id: 'ar_101', beneficiary_ref: 'aff_' + 'd'.repeat(32), kind: 'affiliate', order_ref: 'ord_' + 'e'.repeat(16), amount: { amount: '3657', currency: 'BRL', scale: 2 }, occurred_at: '2026-10-09T15:00:00Z', quote }
    const created = await fetch(`${at}/api/v1/affiliates/commissions`, { method: 'POST', headers: H, body: JSON.stringify(body) })
    expect(created.status).toBe(201)
    const c = await created.json()
    expect(c.quote.mode).toBe('launch')
    const rel = await (await fetch(`${at}/api/v1/affiliates/commissions/${c.id}/release`, { method: 'POST', headers: H, body: JSON.stringify({ reason_code: 'usd_launch', occurred_at: new Date().toISOString() }) })).json()
    expect(rel.status).toBe('released')
    expect(rel.payout).toMatchObject({ hold_reason: 'affiliate_settle_off', to: TREASURY }) // pool = a própria tesouraria; nada vai para a rede
    expect(rel.payout.tx_hash).toBeNull()
    const sum = await (await fetch(`${at}/api/v1/affiliates/summary`, { headers: H })).json()
    expect(sum).toMatchObject({ contract: 'v4', capabilities: ['launch_quote'], evidence: { settlement: 'disabled' }, currency: { chain_id: 4217, chain_env: 'mainnet', token: TEMPO_MAINNET_USDC } })
    expect((await fetch(`${at}/pilot/api/affiliates`)).status).toBe(404) // sem leitura pública
    expect((await fetch(`${at}/api/v1/affiliates/batches`, { method: 'POST', headers: H, body: '{}' })).status).toBe(404) // sem lotes do produtor
    expect((await fetch(`${at}/api/v1/orders`, { method: 'POST', headers: H, body: '{}' })).status).toBe(404) // sem a API de pedidos da demo
    expect((await fetch(`${at}/api/v1/affiliates/summary`)).status).toBe(401)
  })
})

describe('produção dos afiliados: launcher', () => {
  const TREASURY_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const // chave pública de TESTE
  const ISSUER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const // chave pública de TESTE
  it('com a liquidação desligada sobe só o core, sem chave; chave no ambiente sem liquidar é recusada', () => {
    const p = productionLaunchPlan(base({ AFFILIATE_LAUNCH_QUOTE: '1' }))
    expect(p.signer).toBeNull()
    expect(Object.keys(p.core)).not.toContain('TREASURY_KEY')
    expect(p.core.TREASURY_ADDRESS).toBe(TREASURY)
    expect(() => productionLaunchPlan(base({ TREASURY_KEY }))).toThrow(/key_without_settle/)
    expect(() => productionLaunchPlan(base({ PIXSETTLE_SEED: 's'.repeat(40) }))).toThrow(/seed_forbidden/)
  })
  it('com a liquidação ligada exige a chave DA tesouraria publicada; o core recebe só endereço e HMAC', () => {
    expect(() => productionLaunchPlan(base({ AFFILIATE_SETTLE: '1' }))).toThrow(/signer_keys_missing/)
    expect(() => productionLaunchPlan(base({ AFFILIATE_SETTLE: '1', TREASURY_KEY, ISSUER_KEY }))).toThrow(/key_address_mismatch/)
    const addr = privateKeyToAccount(TREASURY_KEY).address
    const p = productionLaunchPlan(base({ AFFILIATE_SETTLE: '1', TREASURY_KEY, ISSUER_KEY, TREASURY_ADDRESS: addr, TOKEN: TEMPO_MAINNET_USDC }), 'h'.repeat(64))
    expect(p.signer).toMatchObject({ TREASURY_KEY, ISSUER_KEY, CHAIN_ID: '4217', TOKEN: TEMPO_MAINNET_USDC, FAUCET_TOPUP: '0', SETTLEMENT_HMAC_SECRET: 'h'.repeat(64) })
    expect(p.core).toMatchObject({ SETTLEMENT_URL: 'http://127.0.0.1:7401', SETTLEMENT_HMAC_SECRET: 'h'.repeat(64), TREASURY_ADDRESS: addr, ISSUER_ADDRESS: privateKeyToAccount(ISSUER_KEY).address })
    expect(JSON.stringify(p.core)).not.toContain(TREASURY_KEY.slice(2))
    expect(JSON.stringify(p.core)).not.toContain(ISSUER_KEY.slice(2))
    // e o core aceita essa configuração (assinante local, emissor definido)
    expect(productionConfigFromEnv({ ...p.core, DATABASE_URL: 'postgres://x' }).settle).toBe(true)
  })
})
