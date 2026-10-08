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
  constructor(readonly code: 'config' | 'http' | 'timeout' | 'invalid_response' | 'replay_miss', message: string, readonly status: number | null = null, readonly body: unknown = null) { super(message) }
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
    const live = provider === 'anthropic'
      ? new AnthropicModel(env.COPILOT_API_KEY ?? '', name, env.COPILOT_BASE_URL || undefined)
      : new OpenAICompatibleModel(env.COPILOT_API_KEY ?? '', name, env.COPILOT_BASE_URL ?? '')
    // Orçamento: COPILOT_BUDGET_CALLS_PER_DAY (padrão 200). Inválido ou <= 0 = modelo desligado com motivo, nunca sem teto.
    const budget = Number(env.COPILOT_BUDGET_CALLS_PER_DAY ?? '200')
    if (!Number.isInteger(budget) || budget <= 0) return { model: null, offReason: 'COPILOT_BUDGET_CALLS_PER_DAY inválido' }
    return { model: mode === 'live_record' ? new RecordingModel(live, db) : live, budgetCallsPerDay: budget }
  } catch (e) {
    return { model: null, offReason: (e as Error).message }
  }
}
