// Sobe a demo pública num único contêiner: processo de assinatura (chaves) + core (sem chaves).
// As chaves de TESTNET saem de uma semente secreta (PIXSETTLE_SEED, gerada pela hospedagem), então
// ninguém precisa copiar chave privada à mão, e nada de chave vai para Git, log ou pasta compartilhada.
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { keccak256, stringToBytes, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`variável ${k} ausente`); process.exit(1) } return v }

/** Chave de testnet derivada da semente e do papel. Trocar a semente troca todas as carteiras e o emissor. */
export function deriveKey(seed: string, role: 'treasury' | 'issuer' | 'merchant' | 'hmac'): Hex {
  if (seed.length < 32) throw new Error('PIXSETTLE_SEED curta demais (mínimo 32 caracteres)')
  return keccak256(stringToBytes(`pixsettle-testnet-v1:${role}:${seed}`))
}

const CORE_PASSTHROUGH = ['DATABASE_URL', 'ASAAS_WEBHOOK_TOKEN', 'DIAGNOSTICS_TOKEN', 'TEMPO_RPC', 'EXPLORER', 'PIX_PROVIDER', 'ASAAS_API_KEY', 'ASAAS_CUSTOMER_ID',
    'ASAAS_BASE_URL', 'ASAAS_USER_AGENT', 'ASAAS_PAYER_API_KEY', 'SWEEP_INTERVAL_MS', 'TRUST_PROXY', 'ISSUER_ID',
    // piloto e copiloto (docs/pilot.md, docs/ai-copilot.md); a chave do modelo só vai ao core, nunca ao assinante
    'PILOT_HMAC_SECRET', 'PILOT_OPERATOR_TOKEN', 'PILOT_SOURCE', 'PILOT_SETTLE', 'PILOT_RATE_NUM', 'PILOT_RATE_DEN', 'PILOT_MERCHANT_ADDRESS',
    'COPILOT_MODE', 'COPILOT_PROVIDER', 'COPILOT_MODEL', 'COPILOT_API_KEY', 'COPILOT_BASE_URL',
    'COPILOT_BUDGET_CALLS_PER_DAY', 'PUBLIC_REPLAY_READ_ONLY', 'PILOT_V1_DISABLED', 'RENDER_GIT_COMMIT',
    'PILOT_SHADOW_KEYRING_JSON', 'PILOT_SHADOW_TOKENS_JSON', 'PILOT_SHADOW_PUBLIC',
    'COPILOT_BUDGET_MICROS', 'COPILOT_CALL_RESERVE_MICROS', 'COPILOT_MAX_CALLS',
    // fase 2 (docs/affiliate-payouts.md): flags, cotação, lojista público, correntes e chaves/tokens de LOTE (HMAC do produtor e do recibo);
    // só o core recebe isso; chave da tesouraria, do emissor e a semente nunca entram aqui
    'AFFILIATE_PAYOUTS', 'AFFILIATE_SETTLE', 'AFFILIATE_QUOTE_SOURCE', 'AFFILIATE_SIM_PRICE4', 'AFFILIATE_LOCK_TTL_MS', 'AFFILIATE_PUBLIC_MERCHANT_ID',
    'AFFILIATE_ALLOW_WRITES_ON_PUBLIC_REPLAY', 'AFFILIATE_STREAMS_JSON', 'AFFILIATE_KEYS_JSON', 'AFFILIATE_TOKENS_JSON', 'AFFILIATE_RECEIPT_KEY']
/** Nomes dinâmicos permitidos (mesmas regras de batchConfig e do piloto); qualquer outro nome fica de fora, inclusive TREASURY_KEY/ISSUER_KEY/PIXSETTLE_SEED. */
const CORE_PASSTHROUGH_PATTERNS = [/^PILOT_SHADOW_KEY_[A-Z0-9_]{1,47}$/, /^PILOT_SHADOW_TOKEN_[A-Z0-9_]{1,45}$/, /^AFFILIATE_KEY_[A-Z0-9_]{1,48}$/, /^AFFILIATE_TOKEN_[A-Z0-9_]{1,48}$/]

export function corePassthroughEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const dynamicNames = Object.keys(env).filter(k => CORE_PASSTHROUGH_PATTERNS.some(rx => rx.test(k)))
  return Object.fromEntries([...CORE_PASSTHROUGH, ...dynamicNames].map(k => [k, env[k]]))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = need('PIXSETTLE_SEED')
  const treasuryKey = (process.env.TREASURY_KEY as Hex | undefined) ?? deriveKey(seed, 'treasury')
  const issuerKey = (process.env.ISSUER_KEY as Hex | undefined) ?? deriveKey(seed, 'issuer')
  const merchantAddress = process.env.DEMO_MERCHANT_ADDRESS ?? privateKeyToAccount(deriveKey(seed, 'merchant')).address
  const hmac = process.env.SETTLEMENT_HMAC_SECRET ?? deriveKey(seed, 'hmac').slice(2)
  const token = process.env.TOKEN ?? '0x20c0000000000000000000000000000000000000'
  const settlementPort = process.env.SETTLEMENT_PORT ?? '7401'

  const children: ChildProcess[] = []
  const run = (name: string, cwd: string, file: string, env: Record<string, string | undefined>) => {
    // Cada processo recebe SÓ as variáveis de que precisa: o core nunca vê chave privada.
    const net = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'TZ'] // rede e certificados, sem segredos
    const base = { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? 'production', HOME: process.env.HOME, ...Object.fromEntries(net.map(k => [k, process.env[k]])) }
    const clean = Object.fromEntries(Object.entries({ ...base, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>
    const c = spawn(process.execPath, ['--import', 'tsx', file], { cwd: root + cwd, env: clean, stdio: 'inherit' })
    c.on('exit', (code, sig) => { console.error(`${name} saiu (${code ?? sig}); encerrando o contêiner para a hospedagem reiniciar`); for (const o of children) o.kill('SIGTERM'); process.exit(1) })
    children.push(c)
  }

  run('settlement', 'settlement', 'src/server.ts', {
    PORT: settlementPort, SETTLEMENT_HMAC_SECRET: hmac, TREASURY_KEY: treasuryKey, ISSUER_KEY: issuerKey, TOKEN: token,
    TEMPO_RPC: process.env.TEMPO_RPC, FAUCET_TOPUP: process.env.FAUCET_TOPUP, TREASURY_MIN_UNITS: process.env.TREASURY_MIN_UNITS,
  })
  // Espera o processo de assinatura aceitar conexão antes de subir o core.
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://127.0.0.1:${settlementPort}/v1/pending-nonce`).then(r => r.status === 401, () => false) // 401 = vivo (sem HMAC)
    if (ok) break
    await new Promise(r => setTimeout(r, 500))
  }
  run('core', 'core', 'src/server.ts', {
    ...corePassthroughEnv(process.env),
    DEMO_MODE: '1', PORT: process.env.PORT ?? '8080', HOST: process.env.HOST ?? '0.0.0.0',
    SETTLEMENT_URL: `http://127.0.0.1:${settlementPort}`, SETTLEMENT_HMAC_SECRET: hmac,
    TREASURY_ADDRESS: privateKeyToAccount(treasuryKey).address, ISSUER_ADDRESS: privateKeyToAccount(issuerKey).address,
    DEMO_MERCHANT_ADDRESS: merchantAddress, TOKEN: token,
  })
  console.log(`tesouraria ${privateKeyToAccount(treasuryKey).address}, emissor ${privateKeyToAccount(issuerKey).address}, lojista demo ${merchantAddress}`)
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 3000).unref() })
}
