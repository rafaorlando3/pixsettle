// Ponto de entrada do core: API + páginas + worker da outbox no mesmo processo.
// As chaves NÃO ficam aqui: o core só fala com o processo de assinatura (settlement/) por HMAC.
import { createPool } from './db.js'
import { migrate } from './migrate.js'
import { defaultConfig, type Ctx } from './context.js'
import { SimulatedPixProvider } from './providers/simulated.js'
import { HttpChainGateway } from './chain/gateway.js'
import { buildApp } from './app.js'
import { registerWeb } from './web.js'
import { registerDemo } from './demo.js'
import { runOnce } from './outbox.js'

export type CoreEnv = Record<string, string | undefined>

export async function startCore(env: CoreEnv = process.env) {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`variável ${k} ausente`); return v }
  const demo = env.DEMO_MODE === '1'
  if (!demo) throw new Error('provedor Asaas ainda não ligado nesta versão: rode com DEMO_MODE=1 (Pix simulado)')
  const tempoRpc = env.TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz'
  const explorer = env.EXPLORER ?? 'https://explore.testnet.tempo.xyz'
  const token = env.TOKEN ?? '0x20c0000000000000000000000000000000000000'
  const webhookToken = need('ASAAS_WEBHOOK_TOKEN')

  const db = createPool(need('DATABASE_URL'))
  await migrate(db)
  const ctx: Ctx = {
    db, provider: new SimulatedPixProvider(), now: () => new Date(),
    chain: new HttpChainGateway(env.SETTLEMENT_URL ?? 'http://127.0.0.1:7401', need('SETTLEMENT_HMAC_SECRET'), Number(env.CHAIN_ID ?? 42431), token, need('TREASURY_ADDRESS')),
    cfg: defaultConfig({ issuer: { id: env.ISSUER_ID ?? 'pixsettle-demo', address: need('ISSUER_ADDRESS') } }),
  }
  const app = buildApp(ctx, { asaasWebhookToken: webhookToken, diagnosticsToken: need('DIAGNOSTICS_TOKEN'), tempoRpc })
  registerWeb(app, ctx, { tempoRpc, explorer, demo })
  if (demo) await registerDemo(app, ctx, { webhookToken, merchantAddress: need('DEMO_MERCHANT_ADDRESS'), explorer })

  // Worker da outbox. Erro de um job fica gravado no próprio job (last_error); aqui só o que escapa.
  let stopping = false
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const worker = (async () => {
    while (!stopping) {
      try { if (!(await runOnce(ctx))) await sleep(200) } catch (e) { console.error('worker:', (e as Error).message); await sleep(1000) }
    }
  })()

  const port = Number(env.PORT ?? 8080), host = env.HOST ?? '127.0.0.1'
  await app.listen({ port, host })
  return {
    app, ctx, url: `http://${host}:${port}`,
    stop: async () => { stopping = true; await worker; await app.close(); await db.end() },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startCore().then(s => console.log(`core ouvindo em ${s.url}`)).catch(e => { console.error(e.message); process.exit(1) })
}
