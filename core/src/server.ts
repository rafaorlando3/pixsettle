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
import { registerPilot } from './pilot/routes.js'
import { copilotFromEnv } from './copilot/model.js'
import { quoteSourceFromEnv } from './affiliates/quotes.js'
import { registerAffiliates } from './affiliates/routes.js'
import { configureAffiliateJournal } from './affiliates/journal.js'
import { resumeAffiliateSettlements, settleOn } from './affiliates/service.js'
import { registerCommissionBatches, streamMap } from './affiliates/batches/routes.js'
import { registerShadow } from './pilot-shadow/routes.js'

export type CoreEnv = Record<string, string | undefined>

export async function startCore(env: CoreEnv = process.env) {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`variável ${k} ausente`); return v }
  const demo = env.DEMO_MODE === '1'
  const shadowPublic = env.PILOT_SHADOW_PUBLIC === '1'
  if (shadowPublic && (env.PUBLIC_REPLAY_READ_ONLY !== '1' || env.COPILOT_MODE !== 'replay' || env.PILOT_SETTLE !== '0')) throw new Error('shadow public requires read-only replay and settlement off')
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
    cfg: defaultConfig({
      issuer: { id: env.ISSUER_ID ?? 'pixsettle-demo', address: need('ISSUER_ADDRESS') },
      // Piloto (eventos atestados): liquidar na testnet cada pedido real pago? Cotação SIMULADA em escala reduzida.
      pilotSettle: env.PILOT_SETTLE === '1' && env.PUBLIC_REPLAY_READ_ONLY !== '1' && env.COPILOT_MODE !== 'replay',
      publicReplayReadOnly: env.PUBLIC_REPLAY_READ_ONLY === '1',
      pilotRateNum: BigInt(env.PILOT_RATE_NUM ?? '1'), pilotRateDen: BigInt(env.PILOT_RATE_DEN ?? '1'),
      pilotPayoutAddress: env.PILOT_MERCHANT_ADDRESS ?? need('DEMO_MERCHANT_ADDRESS'),
    }),
    // Copiloto: COPILOT_MODE off|replay|live|live_record; COPILOT_PROVIDER anthropic|openai; COPILOT_MODEL; COPILOT_API_KEY; COPILOT_BASE_URL.
    copilot: copilotFromEnv(env, db),
    // Fase 2 (AFFILIATE_PAYOUTS=1): comissões em dólar. Liquidar na cadeia só com AFFILIATE_SETTLE=1 (ausente = intenção gravada com motivo
    // affiliate_settle_off); AFFILIATE_QUOTE_SOURCE simulated|binance_usdtbrl; na réplica pública (PUBLIC_REPLAY_READ_ONLY=1) as escritas de
    // afiliados ficam recusadas a menos que AFFILIATE_ALLOW_WRITES_ON_PUBLIC_REPLAY=1 diga explicitamente que entram.
    affiliates: (env.AFFILIATE_PAYOUTS === '1' || env.AFFILIATE_PAYOUTS === 'true') ? {
      quotes: quoteSourceFromEnv(env), settle: env.AFFILIATE_SETTLE === '1',
      writes: env.PUBLIC_REPLAY_READ_ONLY !== '1' || env.AFFILIATE_ALLOW_WRITES_ON_PUBLIC_REPLAY === '1',
      lockTtlMs: Number(env.AFFILIATE_LOCK_TTL_MS ?? 120_000), streams: streamMap(env),
    } : undefined,
  }
  // Uma só autorização para liquidar comissões (rotas, apply, resume, advance, sign e broadcast): AFFILIATE_SETTLE=1 E escritas aceitas.
  configureAffiliateJournal({ settle: ctx.affiliates?.settle === true, writes: ctx.affiliates?.writes !== false })
  if (settleOn(ctx.affiliates)) { const n = await resumeAffiliateSettlements(ctx); if (n) console.log(`comissões em dólar: ${n} liquidação(ões) retomada(s) com AFFILIATE_SETTLE=1`) }
  if (!ctx.copilot?.model) console.log(`copiloto: modelo desligado (${ctx.copilot?.offReason})`)
  else console.log(`copiloto: ${ctx.copilot.model.name} em modo ${ctx.copilot.model.mode}`)
  if (ctx.cfg.publicReplayReadOnly && !(provider instanceof SimulatedPixProvider)) throw new Error('public replay requires the simulated Pix provider')
  const app = buildApp(ctx, { asaasWebhookToken: webhookToken, diagnosticsToken: need('DIAGNOSTICS_TOKEN'), tempoRpc, trustProxy: env.TRUST_PROXY === '1' })
  registerWeb(app, ctx, { tempoRpc, explorer, demo })
  if (demo) await registerDemo(app, ctx, { webhookToken, merchantAddress: need('DEMO_MERCHANT_ADDRESS'), explorer, bench })
  // Piloto: ingestão só com PILOT_HMAC_SECRET; sem ele a rota recusa tudo com motivo (leitura do painel continua).
  registerPilot(app, ctx, { hmacSecret: env.PILOT_HMAC_SECRET ?? '', operatorToken: env.PILOT_OPERATOR_TOKEN ?? '', sourceId: env.PILOT_SOURCE ?? 'odin', v1Disabled: env.PILOT_V1_DISABLED === '1', readOnly: ctx.cfg.publicReplayReadOnly, shadowPublic })
  registerShadow(app, db, env)
  if (ctx.affiliates) { registerAffiliates(app, ctx, { publicMerchantId: env.AFFILIATE_PUBLIC_MERCHANT_ID ?? null }); registerCommissionBatches(app, ctx, env); console.log(`comissões em dólar: ligadas (cotação ${ctx.affiliates.quotes.name}, liquidar ${settleOn(ctx.affiliates) ? 'sim' : 'não'}, escritas ${ctx.affiliates.writes === false ? 'recusadas (réplica pública)' : 'aceitas'}, lojista público ${env.AFFILIATE_PUBLIC_MERCHANT_ID ? 'definido' : 'ausente (leitura pública desligada)'}, correntes mapeadas ${Object.keys(ctx.affiliates.streams ?? {}).length})`) }

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
