// Ponto de entrada do core: API + páginas + worker da outbox no mesmo processo.
// As chaves NÃO ficam aqui: o core só fala com o processo de assinatura (settlement/) por HMAC.
import { createPool } from './db.js'
import { migrate } from './migrate.js'
import { defaultConfig, type Ctx } from './context.js'
import { SimulatedPixProvider } from './providers/simulated.js'
import { AsaasPixProvider, AsaasSandboxPayer, type AsaasOptions } from './providers/asaas.js'
import type { PixProvider } from './providers/types.js'
import { HttpChainGateway } from './chain/gateway.js'
import { buildApp } from './app.js'
import { registerWeb } from './web.js'
import { registerDemo } from './demo.js'
import { defaultSweep } from './flows/sweep.js'
import { startWorker, wakeOnWrites } from './worker.js'

export type CoreEnv = Record<string, string | undefined>

export async function startCore(env: CoreEnv = process.env) {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`variável ${k} ausente`); return v }
  const demo = env.DEMO_MODE === '1'
  if (!demo) throw new Error('esta versão só roda como demo (DEMO_MODE=1): Pix simulado ou Asaas sandbox, Tempo testnet')
  const tempoRpc = env.TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz'
  const explorer = env.EXPLORER ?? 'https://explore.testnet.tempo.xyz'
  const token = env.TOKEN ?? '0x20c0000000000000000000000000000000000000'
  const webhookToken = need('ASAAS_WEBHOOK_TOKEN')

  // Provedor Pix: simulado (padrão) ou Asaas SANDBOX (o adaptador recusa chave e URL de produção).
  const db = createPool(need('DATABASE_URL'))
  await migrate(db)
  // Simulado persiste no banco (tabela própria): a cobrança sobrevive a reinício da demo.
  let provider: PixProvider = new SimulatedPixProvider({ store: db })
  let bench: AsaasSandboxPayer | undefined
  if ((env.PIX_PROVIDER ?? 'simulated') === 'asaas') {
    const ao: AsaasOptions = { apiKey: need('ASAAS_API_KEY'), customerId: need('ASAAS_CUSTOMER_ID'), baseUrl: env.ASAAS_BASE_URL, userAgent: env.ASAAS_USER_AGENT ?? 'PixSettle/0.1' }
    provider = new AsaasPixProvider(ao)
    bench = new AsaasSandboxPayer(ao, env.ASAAS_PAYER_API_KEY || undefined)
  }
  const ctx: Ctx = {
    db, provider, now: () => new Date(),
    chain: new HttpChainGateway(env.SETTLEMENT_URL ?? 'http://127.0.0.1:7401', need('SETTLEMENT_HMAC_SECRET'), Number(env.CHAIN_ID ?? 42431), token, need('TREASURY_ADDRESS')),
    cfg: defaultConfig({ issuer: { id: env.ISSUER_ID ?? 'pixsettle-demo', address: need('ISSUER_ADDRESS') } }),
  }
  const app = buildApp(ctx, { asaasWebhookToken: webhookToken, diagnosticsToken: need('DIAGNOSTICS_TOKEN'), tempoRpc, trustProxy: env.TRUST_PROXY === '1' })
  registerWeb(app, ctx, { tempoRpc, explorer, demo })
  if (demo) await registerDemo(app, ctx, { webhookToken, merchantAddress: need('DEMO_MERCHANT_ADDRESS'), explorer, bench })

  // Worker da outbox com estado ocioso de zero consultas (src/worker.ts). Erro de um job fica gravado
  // no próprio job (last_error); erro do banco vira espera crescente com motivo, nunca "fila vazia".
  const simulated = provider instanceof SimulatedPixProvider
  const sweepCfg = {
    ...defaultSweep,
    // Com o Pix SIMULADO nada muda "lá fora" sem uma requisição nossa (que acorda o worker), então não há
    // por que continuar observando cobrança já recebida. Com o Asaas, mantém a janela de 2 dias.
    recentReceivedMs: Number(env.SWEEP_RECENT_RECEIVED_MS ?? (simulated ? 0 : defaultSweep.recentReceivedMs)),
  }
  const worker = startWorker(ctx, {
    sweepEveryMs: Number(env.SWEEP_INTERVAL_MS ?? 300_000), // contrato: a cada 5 minutos, enquanto houver o que conciliar
    sweep: sweepCfg,
    maxIdleMs: env.WORKER_MAX_IDLE_MS ? Number(env.WORKER_MAX_IDLE_MS) : null,
  })
  // Acorda depois de cada requisição que pode gravar (o handler já fez commit antes de responder).
  wakeOnWrites(app, worker)

  const port = Number(env.PORT ?? 8080), host = env.HOST ?? '127.0.0.1'
  await app.listen({ port, host })
  return {
    app, ctx, url: `http://${host}:${port}`,
    worker,
    stop: async () => { await worker.stop(); await app.close(); await db.end() },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startCore().then(s => console.log(`core ouvindo em ${s.url}`)).catch(e => { console.error(e.message); process.exit(1) })
}
