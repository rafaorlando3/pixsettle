// Modelo do copiloto: interface única, dois provedores HTTP (Anthropic Messages e OpenAI-compatible),
// replay gravado (demo pública sem chave) e gravação. Toda falha sai com motivo; nada é inventado.
import type { Db, Tx } from '../db.js'
import { recordModelAttempt } from '../release-runtime.js'
import { hashOf, type Verdict } from './verdict.js'

export type ModelInput = {
  system: string
  user: string
}
export type ModelOutput = {
  text: string
  usage?: Record<string, number>
  latencyMs: number
}
export class ModelError extends Error {
  constructor(readonly code: 'config' | 'http' | 'timeout' | 'invalid_response' | 'replay_miss' | 'budget', message: string, readonly status: number | null = null, readonly body: unknown = null) { super(message) }
}

export interface CopilotModel {
  readonly name: string
  /** 'live' chama a rede; 'replay' só lê respostas gravadas. */
  readonly mode: 'live' | 'replay'
  complete(input: ModelInput): Promise<ModelOutput>
}

export function safeUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const safe: Record<string, number> = {}
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'cost']) {
    const value = (raw as Record<string, unknown>)[k]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000_000) safe[k] = value
  }
  return Object.keys(safe).length ? safe : undefined
}

export const MAX_MODEL_RESPONSE_BYTES = 128 * 1024
async function responseBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) {
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MAX_MODEL_RESPONSE_BYTES) throw new ModelError('invalid_response', 'response_too_large', response.status)
    return body
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) { cancel(); throw new ModelError('timeout', 'response_deadline') }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_MODEL_RESPONSE_BYTES) { cancel(); throw new ModelError('invalid_response', 'response_too_large', response.status) }
      chunks.push(value)
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
    catch { throw new ModelError('invalid_response', 'response_invalid_utf8', response.status) }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock() }
}

const timeoutFetch = async (url: string, init: RequestInit, ms: number): Promise<{ response: Response; body: string }> => {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new ModelError('timeout', `modelo não respondeu em ${ms} ms`)) }, ms)
  })
  const request = (async () => {
    recordModelAttempt()
    const response = await fetch(url, { ...init, signal: ac.signal })
    // Failed HTTP bodies are unnecessary and may contain private provider material.
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return { response, body: '' } }
    const body = await responseBody(response, ac.signal)
    return { response, body }
  })()
  try { return await Promise.race([request, deadline]) }
  catch (e) {
    if (e instanceof ModelError) throw e
    if ((e as Error).name === 'AbortError') throw new ModelError('timeout', `modelo não respondeu em ${ms} ms`)
    throw new ModelError('http', 'network_error')
  }
  finally { if (timer) clearTimeout(timer) }
}

/** Anthropic Messages API. Chave só na memória do processo; nunca em log. */
export class AnthropicModel implements CopilotModel {
  readonly mode = 'live' as const
  constructor(private readonly apiKey: string, readonly name: string, private readonly baseUrl = 'https://api.anthropic.com', private readonly timeoutMs = 45_000) {
    if (!apiKey) throw new ModelError('config', 'COPILOT_API_KEY ausente')
    if (!name) throw new ModelError('config', 'COPILOT_MODEL ausente')
  }
  async complete(input: ModelInput): Promise<ModelOutput> {
    const t0 = Date.now()
    const { response: r, body } = await timeoutFetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.name, max_tokens: 700, temperature: 0, system: input.system, messages: [{ role: 'user', content: input.user }] }),
    }, this.timeoutMs)
    if (!r.ok) throw new ModelError('http', 'provider_http_error', r.status)
    let j: any
    try { j = JSON.parse(body) } catch { throw new ModelError('invalid_response', 'anthropic: corpo não é JSON', r.status) }
    const text = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    if (!text) throw new ModelError('invalid_response', 'provider_response_without_text', r.status)
    return { text, usage: safeUsage(j.usage), latencyMs: Date.now() - t0 }
  }
}

/** Qualquer servidor compatível com /v1/chat/completions (Gemini via OpenAI-compat, vLLM, Public AI...). */
export class OpenAICompatibleModel implements CopilotModel {
  readonly mode = 'live' as const
  constructor(private readonly apiKey: string, readonly name: string, private readonly baseUrl: string, private readonly timeoutMs = 45_000) {
    if (!baseUrl) throw new ModelError('config', 'COPILOT_BASE_URL ausente')
    if (!name) throw new ModelError('config', 'COPILOT_MODEL ausente')
  }
  async complete(input: ModelInput): Promise<ModelOutput> {
    const t0 = Date.now()
    const { response: r, body } = await timeoutFetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.name, temperature: 0, max_tokens: 700, messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }] }),
    }, this.timeoutMs)
    if (!r.ok) throw new ModelError('http', 'provider_http_error', r.status)
    let j: any
    try { j = JSON.parse(body) } catch { throw new ModelError('invalid_response', 'openai-compat: corpo não é JSON', r.status) }
    const text = j.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text) throw new ModelError('invalid_response', 'provider_response_without_text', r.status)
    return { text, usage: safeUsage(j.usage), latencyMs: Date.now() - t0 }
  }
}

/** Replay: só devolve o que já foi gravado para a MESMA entrada e o MESMO modelo. Falta = erro com motivo. */
export class ReplayModel implements CopilotModel {
  readonly mode = 'replay' as const
  constructor(private readonly db: Db, readonly name: string) {}
  async complete(input: ModelInput): Promise<ModelOutput> {
    const key = hashOf(input)
    const r = (await this.db.query(`SELECT response FROM copilot_replay WHERE input_hash=$1 AND model=$2`, [key, this.name])).rows[0]
    if (!r) throw new ModelError('replay_miss', `sem resposta gravada para esta entrada (modelo ${this.name}, hash ${key.slice(0, 12)})`)
    return { text: String(r.response.text ?? ''), usage: safeUsage(r.response.usage), latencyMs: 0 }
  }
}

/** Recording is explicit and only occurs after verdict validation and the context CAS. */
export class RecordingModel implements CopilotModel {
  readonly mode = 'live' as const
  readonly name: string
  constructor(private readonly inner: CopilotModel, private readonly db: Db) { this.name = inner.name }
  async complete(input: ModelInput): Promise<ModelOutput> { return this.inner.complete(input) }
  async recordValidated(input: ModelInput, verdict: Verdict, out: ModelOutput, db: Db | Tx = this.db): Promise<void> {
    const stored = { ...verdict, rationale: 'Decision recorded; inspect action and evidence references.' }
    await db.query(`INSERT INTO copilot_replay (input_hash, model, response) VALUES ($1,$2,$3) ON CONFLICT (input_hash, model) DO NOTHING`,
      [hashOf(input), this.name, JSON.stringify({ text: JSON.stringify(stored), usage: safeUsage(out.usage) ?? null })])
  }
}

export type BudgetConfig = { capMicros: number; reserveMicros: number; maxCalls: number }
export const MAX_BUDGETED_INPUT_BYTES = 16 * 1024
export function budgetFromEnv(env: Record<string, string | undefined>): BudgetConfig {
  const integer = (name: string, fallback?: number) => {
    const value = env[name]
    if (value === undefined || value === '') {
      if (fallback !== undefined) return fallback
      throw new ModelError('config', `${name} ausente`)
    }
    if (!/^[0-9]{1,12}$/.test(value)) throw new ModelError('config', `${name} inválido`)
    const out = Number(value)
    if (!Number.isSafeInteger(out) || out <= 0) throw new ModelError('config', `${name} inválido`)
    return out
  }
  const capMicros = integer('COPILOT_BUDGET_MICROS')
  const reserveMicros = integer('COPILOT_CALL_RESERVE_MICROS', 20_000)
  const maxCalls = integer('COPILOT_MAX_CALLS', 200)
  if (capMicros > 20_000_000) throw new ModelError('config', 'budget_cap_exceeds_shared20')
  if (reserveMicros > capMicros) throw new ModelError('config', 'budget_reserve_exceeds_cap')
  return { capMicros, reserveMicros, maxCalls }
}

/** Durable USD reservation. Unknown charge/crash stops admission; no automatic repeat of an input.
 * The DB serializes inference across processes, not just reserve INSERTs. The pricing/input bound
 * must be established for the configured provider/model before live capture; the private executor
 * enforces its OpenRouter price cap. This ledger is PixSettle's envelope, not K3a's shared ledger.
 */
export class BudgetedModel implements CopilotModel {
  readonly mode = 'live' as const
  readonly name: string
  constructor(private readonly inner: CopilotModel, private readonly db: Db, readonly budget: BudgetConfig) {
    this.name = inner.name
    for (const value of [budget.capMicros, budget.reserveMicros, budget.maxCalls]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new ModelError('config', 'budget_config_invalid')
    }
    if (budget.reserveMicros > budget.capMicros) throw new ModelError('config', 'budget_reserve_exceeds_cap')
    if (budget.capMicros > 20_000_000) throw new ModelError('config', 'budget_cap_exceeds_shared20')
    if (this.name === 'openai/gpt-4.1-mini' && budget.reserveMicros < 8200) throw new ModelError('config', 'budget_known_model_reserve_too_small')
  }
  async complete(input: ModelInput): Promise<ModelOutput> {
    if (Buffer.byteLength(input.system, 'utf8') + Buffer.byteLength(input.user, 'utf8') > MAX_BUDGETED_INPUT_BYTES) {
      throw new ModelError('budget', 'budget_input_limit')
    }
    const client = await this.db.connect()
    let locked = false, id: string | undefined
    try {
      // Nonblocking admission avoids holding every pool connection behind a slow HTTP call.
      const acquired = (await client.query(`SELECT pg_try_advisory_lock(hashtext('pixsettle_copilot_budget')) AS acquired`)).rows[0]?.acquired
      if (acquired !== true) throw new ModelError('budget', 'budget_in_flight')
      locked = true
      await client.query('BEGIN')
      try {
        const { capMicros, reserveMicros, maxCalls } = this.budget
        await client.query(`INSERT INTO copilot_budget_policy(singleton,model,cap_micros,reserve_micros,max_calls)
          VALUES(true,$1,$2,$3,$4) ON CONFLICT(singleton) DO NOTHING`, [this.name, capMicros, reserveMicros, maxCalls])
        const policy = (await client.query(`SELECT model,cap_micros,reserve_micros,max_calls,halted FROM copilot_budget_policy WHERE singleton=true FOR UPDATE`)).rows[0]
        if (policy.model !== this.name || BigInt(policy.cap_micros) !== BigInt(capMicros) || BigInt(policy.reserve_micros) !== BigInt(reserveMicros) || BigInt(policy.max_calls) !== BigInt(maxCalls)) {
          throw new ModelError('config', 'budget_policy_changed')
        }
        const used = (await client.query(`SELECT count(*)::bigint AS calls,
          coalesce(sum(greatest(reserved_micros,coalesce(cost_micros,0))),0)::text AS used,
          count(*) FILTER(WHERE state IN ('reserved','failed') OR cost_micros IS NULL)::bigint AS unknown
          FROM copilot_spend`)).rows[0]
        if (policy.halted || BigInt(used.unknown) > 0n) throw new ModelError('budget', 'budget_charge_unknown')
        if (BigInt(used.calls) >= BigInt(maxCalls) || BigInt(used.used) + BigInt(reserveMicros) > BigInt(capMicros)) throw new ModelError('budget', 'budget_exhausted')
        const duplicate = (await client.query('SELECT id FROM copilot_spend WHERE model=$1 AND input_hash=$2', [this.name, hashOf(input)])).rows[0]
        if (duplicate) throw new ModelError('budget', 'budget_input_already_attempted')
        id = (await client.query(`INSERT INTO copilot_spend(model,input_hash,reserved_micros,state)
          VALUES($1,$2,$3,'reserved') RETURNING id`, [this.name, hashOf(input), reserveMicros])).rows[0].id
        await client.query('COMMIT') // survives process loss before/after the HTTP call
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
      let out: ModelOutput
      try { out = await this.inner.complete(input) }
      catch (error) {
        const errorCode = error instanceof ModelError ? error.code : 'internal_error'
        // Failure has no proof of zero charge. Keep the reservation and stop the whole envelope.
        await client.query('BEGIN')
        try {
          await client.query(`UPDATE copilot_spend SET state='failed',error_code=$2,settled_at=now() WHERE id=$1`, [id, errorCode])
          await client.query(`UPDATE copilot_budget_policy SET halted=true,halt_code='unknown_charge' WHERE singleton=true`)
          await client.query('COMMIT')
        } catch { await client.query('ROLLBACK').catch(() => {}); throw new ModelError('budget', 'budget_storage_failed') }
        throw error
      }
      const rawCost = out.usage?.cost
      const micros = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0 ? Math.ceil(rawCost * 1_000_000) : null
      const cost = micros !== null && Number.isSafeInteger(micros) ? micros : null
      await client.query('BEGIN')
      try {
        await client.query(`UPDATE copilot_spend SET state='spent',cost_micros=$2,settled_at=now() WHERE id=$1`, [id, cost])
        if (cost === null || cost > this.budget.reserveMicros) {
          await client.query(`UPDATE copilot_budget_policy SET halted=true,halt_code=$1 WHERE singleton=true`, [cost === null ? 'unknown_charge' : 'cost_over_reserve'])
        }
        await client.query('COMMIT')
      } catch { await client.query('ROLLBACK').catch(() => {}); throw new ModelError('budget', 'budget_storage_failed') }
      return out
    } catch (error) {
      if (error instanceof ModelError) throw error
      throw new ModelError('budget', 'budget_storage_failed')
    } finally {
      let destroyConnection = false
      if (locked) {
        try { if ((await client.query(`SELECT pg_advisory_unlock(hashtext('pixsettle_copilot_budget')) AS released`)).rows[0]?.released !== true) destroyConnection = true }
        catch { destroyConnection = true }
      }
      client.release(destroyConnection)
    }
  }
}

/** Modelo de teste: respostas programadas por quem escreve o teste. */
export class ScriptedModel implements CopilotModel {
  readonly mode = 'live' as const
  readonly calls: ModelInput[] = []
  constructor(readonly name: string, private readonly script: (input: ModelInput, n: number) => string | Promise<string>) {}
  async complete(input: ModelInput): Promise<ModelOutput> {
    this.calls.push(input)
    const text = await this.script(input, this.calls.length)
    return { text, latencyMs: 1 }
  }
}

/** Fábrica a partir do ambiente. Sem chave: modelo nulo com o motivo (a tela mostra "model_off: ..."). */
export function copilotFromEnv(env: Record<string, string | undefined>, db: Db): { model: CopilotModel | null; offReason?: string; budgetCallsPerDay?: number } {
  const mode = env.COPILOT_MODE ?? 'off'
  const name = env.COPILOT_MODEL ?? ''
  try {
    if (mode === 'off') return { model: null, offReason: 'COPILOT_MODE=off' }
    if (mode === 'replay') { if (!name) return { model: null, offReason: 'COPILOT_MODEL ausente para replay' }; return { model: new ReplayModel(db, name) } }
    if (mode !== 'live' && mode !== 'live_record') return { model: null, offReason: 'COPILOT_MODE desconhecido' }
    const provider = env.COPILOT_PROVIDER ?? 'anthropic'
    const usdBudget = budgetFromEnv(env)
    const raw = provider === 'anthropic'
      ? new AnthropicModel(env.COPILOT_API_KEY ?? '', name, env.COPILOT_BASE_URL || undefined)
      : new OpenAICompatibleModel(env.COPILOT_API_KEY ?? '', name, env.COPILOT_BASE_URL ?? '')
    const live = new BudgetedModel(raw, db, usdBudget)
    // Orçamento: COPILOT_BUDGET_CALLS_PER_DAY (padrão 200). Inválido ou <= 0 = modelo desligado com motivo, nunca sem teto.
    const budget = Number(env.COPILOT_BUDGET_CALLS_PER_DAY ?? '200')
    if (!Number.isInteger(budget) || budget <= 0) return { model: null, offReason: 'COPILOT_BUDGET_CALLS_PER_DAY inválido' }
    return { model: mode === 'live_record' ? new RecordingModel(live, db) : live, budgetCallsPerDay: budget }
  } catch (e) {
    return { model: null, offReason: (e as Error).message }
  }
}
