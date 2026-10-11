// Launcher da PRODUÇÃO dos afiliados (dinheiro real). Sem semente, sem demo.
// AFFILIATE_SETTLE=0 (padrão): sobe só o core de produção, sem chave nenhuma (tesouraria = endereço público).
// AFFILIATE_SETTLE=1 (gate de credencial próprio): exige TREASURY_KEY e ISSUER_KEY, confere que a chave é da TREASURY_ADDRESS
// publicada (senão recusa), sobe o assinante (settlement/) com CHAIN_ID e só então o core, que recebe endereço e HMAC, nunca a chave.
// v7.4 (X-1222, K1): a ordem é plano público (sem chave) -> banco conferido -> chave lida e derivada -> filhos.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { assertNoForbiddenProductionFlags, productionConfigFromEnv, profileOf } from '../src/affiliates/production.js'
import { bindDatabaseProfile, profileFingerprint, withBootLock, type BoundProfile, type InstanceProfile } from '../src/affiliates/instance-profile.js'
import { createPool } from '../src/db.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const NET = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'TZ']
/** Só o que o core de produção lê; chave privada, semente e HMAC alheio nunca entram aqui. */
const CORE_ENV = ['PIXSETTLE_PROFILE', 'CHAIN_ID', 'TREASURY_ADDRESS', 'TOKEN', 'DATABASE_URL', 'AFFILIATE_QUOTE_SOURCE', 'AFFILIATE_QUOTE_URL', 'AFFILIATE_SIM_PRICE4',
  'AFFILIATE_SETTLE', 'AFFILIATE_LAUNCH_QUOTE', 'AFFILIATE_LOCK_TTL_MS', 'ISSUER_ID', 'ISSUER_ADDRESS', 'PORT', 'HOST', 'TRUST_PROXY', 'PRODUCTION_REHEARSAL',
  'RENDER_GIT_COMMIT', 'GIT_COMMIT']

export type LaunchPlan = { signer: Record<string, string> | null; core: Record<string, string> }

/** v7.4 (X-1222, K1): a parte PÚBLICA do plano, decidida sem tocar em TREASURY_KEY nem ISSUER_KEY. */
export type PublicLaunchPlan = { settle: boolean; core: Record<string, string>; profile: InstanceProfile; signerPort: string | null }

/** Endereço só para validar a forma da configuração antes da fase com credencial (nunca vai para o core). */
const PLACEHOLDER_ISSUER = '0x000000000000000000000000000000000000dEaD'

/**
 * Fase 1 (pura, sem chave): flags proibidas no ambiente ORIGINAL (v7.2, X-1205), só as variáveis públicas do core, a
 * configuração validada pela mesma função do boot e o perfil que prende o banco. Não lê TREASURY_KEY nem ISSUER_KEY (nem a
 * presença delas): isso é da fase 2, depois de o banco ser conferido (v7.4, X-1222 K1).
 */
export function publicLaunchPlan(env: Record<string, string | undefined>): PublicLaunchPlan {
  assertNoForbiddenProductionFlags(env)
  const pick = (names: string[]) => Object.fromEntries(names.map(k => [k, env[k]]).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>
  const core = pick(CORE_ENV)
  if (env.AFFILIATE_SETTLE !== '1') return { settle: false, core, profile: profileOf(productionConfigFromEnv(core)), signerPort: null }
  if (!env.TOKEN || !env.CHAIN_ID) throw new Error('signer_chain_missing: CHAIN_ID e TOKEN obrigatórios para assinar')
  const signerPort = env.SETTLEMENT_PORT ?? '7401'
  // a forma da configuração com assinante, com o que só a fase 2 conhece trocado por valores de forma (HMAC e, quando não
  // informado, o endereço do emissor que sai da chave)
  const probe = { ...core, SETTLEMENT_URL: `http://127.0.0.1:${signerPort}`, SETTLEMENT_HMAC_SECRET: 'f'.repeat(64), ISSUER_ADDRESS: core.ISSUER_ADDRESS ?? PLACEHOLDER_ISSUER }
  return { settle: true, core, profile: profileOf(productionConfigFromEnv(probe)), signerPort }
}

/**
 * Fase 2 (depois do banco conferido): chave presente só com AFFILIATE_SETTLE=1, chave da tesouraria tem de ser da
 * TREASURY_ADDRESS publicada (a mesma do perfil que o banco já conferiu), ambiente do assinante e do core.
 */
export function credentialLaunchPlan(env: Record<string, string | undefined>, pub: PublicLaunchPlan, hmac = randomBytes(32).toString('hex')): LaunchPlan {
  if (!pub.settle) {
    if (env.TREASURY_KEY || env.ISSUER_KEY) throw new Error('key_without_settle: chave presente com AFFILIATE_SETTLE desligado; tire a chave do ambiente (o core não assina)')
    return { signer: null, core: pub.core }
  }
  const treasuryKey = env.TREASURY_KEY as Hex | undefined, issuerKey = env.ISSUER_KEY as Hex | undefined
  if (!treasuryKey || !issuerKey) throw new Error('signer_keys_missing: AFFILIATE_SETTLE=1 exige TREASURY_KEY e ISSUER_KEY no ambiente do launcher')
  let derived: string, issuerDerived: string
  try { derived = privateKeyToAccount(treasuryKey).address; issuerDerived = privateKeyToAccount(issuerKey).address } catch {
    throw new Error('signer_key_invalid: TREASURY_KEY ou ISSUER_KEY não é uma chave privada válida; nada sobe') // sem eco da chave
  }
  if (derived.toLowerCase() !== pub.profile.treasury.toLowerCase()) throw new Error('key_address_mismatch: a TREASURY_KEY não é da TREASURY_ADDRESS publicada; nada sobe')
  // v7.4: o emissor publicado tem de ser o da chave que assina os recibos (senão todo recibo falharia na verificação)
  if (pub.core.ISSUER_ADDRESS && issuerDerived.toLowerCase() !== pub.core.ISSUER_ADDRESS.toLowerCase()) throw new Error('issuer_key_mismatch: a ISSUER_KEY não é do ISSUER_ADDRESS publicado; nada sobe')
  const issuer = pub.core.ISSUER_ADDRESS ?? issuerDerived
  const port = pub.signerPort!
  const signer = { PORT: port, SETTLEMENT_HMAC_SECRET: hmac, TREASURY_KEY: treasuryKey, ISSUER_KEY: issuerKey, TOKEN: env.TOKEN!, CHAIN_ID: env.CHAIN_ID!, FAUCET_TOPUP: '0', ...(env.TEMPO_RPC ? { TEMPO_RPC: env.TEMPO_RPC } : {}) }
  const coreEnv = { ...pub.core, SETTLEMENT_URL: `http://127.0.0.1:${port}`, SETTLEMENT_HMAC_SECRET: hmac, ISSUER_ADDRESS: issuer }
  productionConfigFromEnv(coreEnv) // o core recusaria no boot; recusar aqui evita subir o assinante com a chave à toa
  return { signer, core: coreEnv }
}

/**
 * Plano puro composto (testável sem banco): fase 1 e fase 2 em sequência. O launcher de verdade usa `prepareLaunch`, que
 * confere o banco entre as duas fases.
 */
export function productionLaunchPlan(env: Record<string, string | undefined>, hmac = randomBytes(32).toString('hex')): LaunchPlan {
  return credentialLaunchPlan(env, publicLaunchPlan(env), hmac)
}

/**
 * v7.3 (X-1212): antes de subir QUALQUER filho (assinante com a chave ou core), confere e prende o banco ao perfil, sob a
 * trava do boot. O core confere de novo no próprio boot (a linha do perfil recusa UPDATE, DELETE e TRUNCATE por gatilho).
 */
export async function preflightDatabase(pub: Pick<PublicLaunchPlan, 'core' | 'profile'>): Promise<BoundProfile> {
  const db = createPool(pub.core.DATABASE_URL, { profileFingerprint: profileFingerprint(pub.profile), applicationName: 'pixsettle-affiliates-launcher', max: 3 })
  try {
    return await withBootLock(db, () => bindDatabaseProfile(db, pub.profile))
  } finally { await db.end() }
}

/**
 * v7.4 (X-1222, K1): a ordem do launcher. Fase 1 sem chave, banco conferido (e preso, se novo e vazio), só então a fase 2 lê e
 * deriva a chave. Um banco de outro perfil recusa com database_profile_mismatch mesmo com a chave inválida no ambiente.
 */
export async function prepareLaunch(env: Record<string, string | undefined>, preflight: (pub: PublicLaunchPlan) => Promise<BoundProfile> = preflightDatabase): Promise<LaunchPlan> {
  const pub = publicLaunchPlan(env)
  await preflight(pub)
  return credentialLaunchPlan(env, pub)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let plan: LaunchPlan
  try { plan = await prepareLaunch(process.env) } catch (e) { console.error((e as Error).message); process.exit(1) }
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
