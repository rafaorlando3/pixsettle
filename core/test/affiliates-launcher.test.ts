// Lançador do contêiner (scripts/start-all.ts): as configurações da fase 2 chegam ao core; chaves/semente nunca.
import { describe, it, expect } from 'vitest'
import { corePassthroughEnv } from '../scripts/start-all.js'
import { batchConfig, streamMap } from '../src/affiliates/batches/routes.js'

describe('start-all repassa as configurações de afiliados ao core', () => {
  it('11 variáveis da fase 2 e os nomes dinâmicos de chave/token passam; tesouraria, emissor, semente e nomes fora do padrão não', () => {
    const secret = 'x'.repeat(40)
    const env = {
      AFFILIATE_PAYOUTS: '1', AFFILIATE_SETTLE: '1', AFFILIATE_QUOTE_SOURCE: 'binance_usdtbrl', AFFILIATE_PUBLIC_MERCHANT_ID: 'mer_' + 'A'.repeat(26),
      AFFILIATE_ALLOW_WRITES_ON_PUBLIC_REPLAY: '1', AFFILIATE_STREAMS_JSON: JSON.stringify({ 'src_codex212|store_1': 'mer_' + 'A'.repeat(26) }),
      AFFILIATE_KEYS_JSON: JSON.stringify({ k_comm1: { env: 'AFFILIATE_KEY_COMM1', origin: 'src_codex212', stores: ['store_1'] } }), AFFILIATE_KEY_COMM1: secret,
      AFFILIATE_TOKENS_JSON: JSON.stringify([{ env: 'AFFILIATE_TOKEN_COMM1', origin: 'src_codex212' }]), AFFILIATE_TOKEN_COMM1: 'tok-' + 'y'.repeat(40),
      AFFILIATE_RECEIPT_KEY: 'r'.repeat(40), AFFILIATE_LOCK_TTL_MS: '120000', AFFILIATE_SIM_PRICE4: '52000',
      TREASURY_KEY: '0x' + '1'.repeat(64), ISSUER_KEY: '0x' + '2'.repeat(64), PIXSETTLE_SEED: 's'.repeat(40), AFFILIATE_KEY_lower: 'no', AFFILIATE_SECRET_X: 'no', AFFILIATE_KEY_: 'no',
    }
    const core = corePassthroughEnv(env)
    for (const k of ['AFFILIATE_PAYOUTS', 'AFFILIATE_SETTLE', 'AFFILIATE_QUOTE_SOURCE', 'AFFILIATE_PUBLIC_MERCHANT_ID', 'AFFILIATE_ALLOW_WRITES_ON_PUBLIC_REPLAY', 'AFFILIATE_STREAMS_JSON', 'AFFILIATE_KEYS_JSON', 'AFFILIATE_KEY_COMM1', 'AFFILIATE_TOKENS_JSON', 'AFFILIATE_TOKEN_COMM1', 'AFFILIATE_RECEIPT_KEY', 'AFFILIATE_LOCK_TTL_MS', 'AFFILIATE_SIM_PRICE4']) expect(core[k], k).toBe(env[k as keyof typeof env])
    for (const k of ['TREASURY_KEY', 'ISSUER_KEY', 'PIXSETTLE_SEED', 'AFFILIATE_KEY_lower', 'AFFILIATE_SECRET_X', 'AFFILIATE_KEY_']) expect(k in core, k).toBe(false)
    // o que o core faria com esse ambiente: módulo ligado, lotes configurados, corrente mapeada
    expect(core.AFFILIATE_PAYOUTS === '1').toBe(true)
    const cfg = batchConfig(core); expect(cfg?.keys.map(k => k.key_id)).toEqual(['k_comm1']); expect(cfg?.tokens.length).toBe(1)
    expect(Object.keys(streamMap(core))).toEqual(['src_codex212|store_1'])
  })
})
