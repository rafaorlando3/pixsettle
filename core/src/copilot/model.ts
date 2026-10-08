// Modelo do copiloto: interface única, dois provedores HTTP (Anthropic Messages e OpenAI-compatible),
// replay gravado (demo pública sem chave) e gravação. Toda falha sai com motivo; nada é inventado.
import type { Db } from '../db.js'
import { hashOf } from './verdict.js'

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

const timeoutFetch = async (url: string, init: RequestInit, ms: number) => {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try { return await fetch(url, { ...init, signal: ac.signal }) }
  catch (e) { if ((e as Error).name === 'AbortError') throw new ModelError('timeout', `modelo não respondeu em ${ms} ms`); throw new ModelError('http', 'network_error') }
  finally { clearTimeout(t) }
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
    const r = await timeoutFetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.name, max_tokens: 700, temperature: 0, system: input.system, messages: [{ role: 'user', content: input.user }] }),
    }, this.timeoutMs)
    const body = await r.text()
    if (!r.ok) throw new ModelError('http', 'provider_http_error', r.status)
    let j: any
    try { j = JSON.parse(body) } catch { throw new ModelError('invalid_response', 'anthropic: corpo não é JSON', r.status) }
    const text = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    if (!text) throw new ModelError('invalid_response', 'provider_response_without_text', r.status)
    return { text, usage: j.usage ?? undefined, latencyMs: Date.now() - t0 }
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
    const r = await timeoutFetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.name, temperature: 0, max_tokens: 700, messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }] }),
    }, this.timeoutMs)
    const body = await r.text()
    if (!r.ok) throw new ModelError('http', 'provider_http_error', r.status)
    let j: any
    try { j = JSON.parse(body) } catch { throw new ModelError('invalid_response', 'openai-compat: corpo não é JSON', r.status) }
    const text = j.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text) throw new ModelError('invalid_response', 'provider_response_without_text', r.status)
    return { text, usage: j.usage ?? undefined, latencyMs: Date.now() - t0 }
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
    return { text: String(r.response.text ?? ''), usage: r.response.usage ?? undefined, latencyMs: 0 }
  }
}

/** Grava cada resposta ao vivo na tabela de replay (para a demo pública reproduzir depois sem chave). */
export class RecordingModel implements CopilotModel {
  readonly mode = 'live' as const
  readonly name: string
  constructor(private readonly inner: CopilotModel, private readonly db: Db) { this.name = inner.name }
  async complete(input: ModelInput): Promise<ModelOutput> {
    const out = await this.inner.complete(input)
    await this.db.query(`INSERT INTO copilot_replay (input_hash, model, response) VALUES ($1,$2,$3) ON CONFLICT (input_hash, model) DO NOTHING`,
      [hashOf(input), this.name, JSON.stringify({ text: out.text, usage: out.usage ?? null })])
    return out
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
