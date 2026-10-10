// Launcher da PRODUÇÃO dos afiliados (dinheiro real). Sem semente, sem demo.
// AFFILIATE_SETTLE=0 (padrão): sobe só o core de produção, sem chave nenhuma (tesouraria = endereço público).
// AFFILIATE_SETTLE=1 (gate de credencial próprio): exige TREASURY_KEY e ISSUER_KEY, confere que a chave é da TREASURY_ADDRESS
// publicada (senão recusa), sobe o assinante (settlement/) com CHAIN_ID e só então o core, que recebe endereço e HMAC, nunca a chave.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { assertNoForbiddenProductionFlags, productionConfigFromEnv } from '../src/affiliates/production.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const NET = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'TZ']
/** Só o que o core de produção lê; chave privada, semente e HMAC alheio nunca entram aqui. */
const CORE_ENV = ['PIXSETTLE_PROFILE', 'CHAIN_ID', 'TREASURY_ADDRESS', 'TOKEN', 'DATABASE_URL', 'AFFILIATE_QUOTE_SOURCE', 'AFFILIATE_QUOTE_URL', 'AFFILIATE_SIM_PRICE4',
  'AFFILIATE_SETTLE', 'AFFILIATE_LAUNCH_QUOTE', 'AFFILIATE_LOCK_TTL_MS', 'ISSUER_ID', 'ISSUER_ADDRESS', 'PORT', 'HOST', 'TRUST_PROXY', 'PRODUCTION_REHEARSAL',
  'RENDER_GIT_COMMIT', 'GIT_COMMIT']

export type LaunchPlan = { signer: Record<string, string> | null; core: Record<string, string> }

/**
 * Plano puro (testável): quem sobe, com quais variáveis. Recusa chave que não bate com o endereço publicado.
 * v7.2 (revisão X-1205, F3): as flags proibidas são conferidas no ambiente ORIGINAL, antes do filtro do CORE_ENV (filtrar não
 * esconde DEMO_MODE, leitura pública, lotes do produtor nem ensaio com liquidação), e o ambiente que o core vai receber é
 * validado inteiro pela mesma função do boot antes de o plano voltar: nada sobe (assinante ou core) com configuração recusada.
 */
export function productionLaunchPlan(env: Record<string, string | undefined>, hmac = randomBytes(32).toString('hex')): LaunchPlan {
  assertNoForbiddenProductionFlags(env)
  const pick = (names: string[]) => Object.fromEntries(names.map(k => [k, env[k]]).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>
  const core = pick(CORE_ENV)
  if (env.AFFILIATE_SETTLE !== '1') {
    if (env.TREASURY_KEY || env.ISSUER_KEY) throw new Error('key_without_settle: chave presente com AFFILIATE_SETTLE desligado; tire a chave do ambiente (o core não assina)')
    productionConfigFromEnv(core)
    return { signer: null, core }
  }
  const treasuryKey = env.TREASURY_KEY as Hex | undefined, issuerKey = env.ISSUER_KEY as Hex | undefined
  if (!treasuryKey || !issuerKey) throw new Error('signer_keys_missing: AFFILIATE_SETTLE=1 exige TREASURY_KEY e ISSUER_KEY no ambiente do launcher')
  const derived = privateKeyToAccount(treasuryKey).address
  if (derived.toLowerCase() !== String(env.TREASURY_ADDRESS ?? '').toLowerCase()) throw new Error('key_address_mismatch: a TREASURY_KEY não é da TREASURY_ADDRESS publicada; nada sobe')
  if (!env.TOKEN || !env.CHAIN_ID) throw new Error('signer_chain_missing: CHAIN_ID e TOKEN obrigatórios para assinar')
  const port = env.SETTLEMENT_PORT ?? '7401'
  const signer = { PORT: port, SETTLEMENT_HMAC_SECRET: hmac, TREASURY_KEY: treasuryKey, ISSUER_KEY: issuerKey, TOKEN: env.TOKEN, CHAIN_ID: env.CHAIN_ID, FAUCET_TOPUP: '0', ...(env.TEMPO_RPC ? { TEMPO_RPC: env.TEMPO_RPC } : {}) }
  const coreEnv = { ...core, SETTLEMENT_URL: `http://127.0.0.1:${port}`, SETTLEMENT_HMAC_SECRET: hmac, ISSUER_ADDRESS: env.ISSUER_ADDRESS ?? privateKeyToAccount(issuerKey).address }
  productionConfigFromEnv(coreEnv) // o core recusaria no boot; recusar aqui evita subir o assinante com a chave à toa
  return { signer, core: coreEnv }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let plan: LaunchPlan
  try { plan = productionLaunchPlan(process.env) } catch (e) { console.error((e as Error).message); process.exit(1) }
  const children: ChildProcess[] = []
  const base = { PATH: process.env.PATH ?? '', NODE_ENV: 'production', HOME: process.env.HOME ?? '', ...Object.fromEntries(NET.map(k => [k, process.env[k]]).filter(([, v]) => v)) }
  const run = (name: string, cwd: string, file: string, env: Record<string, string>) => {
    const c = spawn(process.execPath, ['--import', 'tsx', file], { cwd: root + cwd, env: { ...base, ...env }, stdio: 'inherit' })
    c.on('exit', (code, sig) => { console.error(`${name} saiu (${code ?? sig}); encerrando para a hospedagem reiniciar`); for (const o of children) o.kill('SIGTERM'); process.exit(1) })
    children.push(c)
  }
  if (plan.signer) {
    run('settlement', 'settlement', 'src/server.ts', plan.signer)
    for (let i = 0; i < 60; i++) {
      const ok = await fetch(`http://127.0.0.1:${plan.signer.PORT}/v1/pending-nonce`).then(r => r.status === 401, () => false)
      if (ok) break
      await new Promise(r => setTimeout(r, 500))
    }
  }
  run('core', 'core', 'src/affiliates/production.ts', plan.core)
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 3000).unref() })
}
