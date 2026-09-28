// Worker da outbox com três estados (contrato 5.1; critérios de ociosidade da revisão do Codex, X-0023).
//
//   busy     há job disponível: roda até esvaziar.
//   waiting  só há job com horário futuro, lease de outro worker, ou varredura pendente: dorme até o
//            mais cedo deles, sem consultar no meio.
//   idle     fila vazia e nada a conciliar: ZERO consultas ao banco até alguém chamar wake()
//            (o servidor chama depois de cada requisição que pode gravar) ou, se configurado, maxIdleMs.
//   error    o banco falhou: nunca é tratado como fila vazia. Espera crescente, com o motivo guardado.
//
// Limite conhecido: o wake() é do mesmo processo. Com mais de um processo gravando na outbox, configure
// maxIdleMs (WORKER_MAX_IDLE_MS) para um teto de sono; a demo roda um processo só.
import type { Ctx } from './context.js'
import { runOnce } from './outbox.js'
import { sweep, sweepNeeded, defaultSweep, type SweepConfig } from './flows/sweep.js'

export type WorkerState = 'starting' | 'busy' | 'waiting' | 'idle' | 'error' | 'stopped'
export type WorkerOptions = {
  sweepEveryMs: number
  sweep?: SweepConfig
  maxIdleMs?: number | null
  errorBackoffMs?: { min: number; max: number }
  log?: (msg: string) => void
  onState?: (s: WorkerState, info: { untilMs: number | null; reason?: string }) => void
}
export type Worker = {
  wake(): void
  stop(): Promise<void>
  readonly state: WorkerState
  readonly lastError: string | null
}

export function startWorker(ctx: Ctx, opts: WorkerOptions): Worker {
  const sweepCfg = opts.sweep ?? defaultSweep
  const backoff = opts.errorBackoffMs ?? { min: 1_000, max: 30_000 }
  const log = opts.log ?? ((m: string) => console.log(m))
  let state: WorkerState = 'starting'
  let lastError: string | null = null
  let woken = false
  let wakeNow: (() => void) | null = null
  let stopping = false
  let lastSweep = 0
  let errDelay = backoff.min

  const set = (s: WorkerState, untilMs: number | null, reason?: string) => {
    if (s !== state || s === 'error') log(`worker: ${state} -> ${s}${untilMs !== null ? ` (${Math.round(untilMs)} ms)` : ''}${reason ? `: ${reason}` : ''}`)
    state = s
    opts.onState?.(s, { untilMs, reason })
  }

  function wake() {
    woken = true
    const w = wakeNow; wakeNow = null
    w?.()
  }

  // Dorme até o prazo (null = até ser acordado). Se um wake chegou antes de dormir, não dorme.
  function sleep(ms: number | null): Promise<void> {
    if (woken || stopping) return Promise.resolve()
    return new Promise(resolve => {
      let t: ReturnType<typeof setTimeout> | undefined
      const done = () => { if (t) clearTimeout(t); wakeNow = null; resolve() }
      wakeNow = done
      if (ms !== null) t = setTimeout(done, Math.max(0, ms))
    })
  }

  // Próximo horário em que há algo para fazer, pelo relógio do banco.
  async function nextDueMs(): Promise<number | null> {
    const r = (await ctx.db.query(
      `SELECT EXTRACT(EPOCH FROM (least(
                (SELECT min(available_at) FROM outbox WHERE done_at IS NULL AND (locked_until IS NULL OR locked_until < now())),
                (SELECT min(locked_until) FROM outbox WHERE done_at IS NULL AND locked_until >= now())
              ) - now())) * 1000 AS ms`)).rows[0]
    return r.ms === null ? null : Math.max(0, Number(r.ms))
  }

  const loop = (async () => {
    while (!stopping) {
      try {
        woken = false // o que chegar daqui em diante impede o sono desta volta (critério: não perder wake)
        set('busy', null)
        let needSweep = false
        if (Date.now() - lastSweep >= opts.sweepEveryMs) {
          needSweep = await sweepNeeded(ctx, sweepCfg)
          if (needSweep) await sweep(ctx, sweepCfg)
          lastSweep = Date.now()
        } else {
          needSweep = await sweepNeeded(ctx, sweepCfg)
        }
        while (!stopping && await runOnce(ctx)) { /* esvazia o que está disponível agora */ }
        const due = await nextDueMs()
        errDelay = backoff.min
        lastError = null
        if (woken || stopping) continue
        let until = due
        if (needSweep) {
          const s = Math.max(0, lastSweep + opts.sweepEveryMs - Date.now())
          until = until === null ? s : Math.min(until, s)
        }
        if (opts.maxIdleMs != null) until = until === null ? opts.maxIdleMs : Math.min(until, opts.maxIdleMs)
        if (until !== null && until <= 0) continue
        set(until === null ? 'idle' : 'waiting', until)
        await sleep(until)
      } catch (e) {
        // Erro do banco não é "fila vazia": guarda o motivo, espera crescente e tenta de novo.
        lastError = (e as Error)?.message ?? String(e)
        set('error', errDelay, lastError)
        await sleep(errDelay)
        errDelay = Math.min(errDelay * 2, backoff.max)
      }
    }
    set('stopped', null)
  })()

  return {
    wake,
    async stop() { stopping = true; wake(); await loop },
    get state() { return state },
    get lastError() { return lastError },
  }
}

/** Acorda o worker depois de cada requisição que pode gravar (o handler já fez commit antes de responder). */
export function wakeOnWrites(app: { addHook: (name: 'onResponse', fn: (req: { method: string }) => Promise<void>) => unknown }, worker: Pick<Worker, 'wake'>) {
  app.addHook('onResponse', async req => { if (req.method !== 'GET' && req.method !== 'HEAD') worker.wake() })
}
