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
  const passthrough = ['DATABASE_URL', 'ASAAS_WEBHOOK_TOKEN', 'DIAGNOSTICS_TOKEN', 'TEMPO_RPC', 'EXPLORER', 'PIX_PROVIDER', 'ASAAS_API_KEY', 'ASAAS_CUSTOMER_ID',
    'ASAAS_BASE_URL', 'ASAAS_USER_AGENT', 'ASAAS_PAYER_API_KEY', 'SWEEP_INTERVAL_MS', 'TRUST_PROXY', 'ISSUER_ID']
  run('core', 'core', 'src/server.ts', {
    ...Object.fromEntries(passthrough.map(k => [k, process.env[k]])),
    DEMO_MODE: '1', PORT: process.env.PORT ?? '8080', HOST: process.env.HOST ?? '0.0.0.0',
    SETTLEMENT_URL: `http://127.0.0.1:${settlementPort}`, SETTLEMENT_HMAC_SECRET: hmac,
    TREASURY_ADDRESS: privateKeyToAccount(treasuryKey).address, ISSUER_ADDRESS: privateKeyToAccount(issuerKey).address,
    DEMO_MERCHANT_ADDRESS: merchantAddress, TOKEN: token,
  })
  console.log(`tesouraria ${privateKeyToAccount(treasuryKey).address}, emissor ${privateKeyToAccount(issuerKey).address}, lojista demo ${merchantAddress}`)
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 3000).unref() })
}
