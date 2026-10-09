// POST /pilot/affiliates/v1/batches: ingestão de lotes assinados (produtor). Chaves por origem (HMAC do lote), token Bearer por origem,
// chave do recibo. Qualquer desvio de configuração = 503 commission_not_configured, nunca configuração parcial.
// Escrito pela rodada agendada do Claude (patch 3) e absorvido aqui: a aplicação ao domínio vai pela outbox depois do commit.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Ctx } from '../../context.js'
import { validateBatch, CommissionError, MAX_BATCH_BYTES, type CommissionKey } from './batch.js'
import { ingestCommissionBatch } from './ingest.js'

const KEY_ENV = /^AFFILIATE_KEY_[A-Z0-9_]{1,48}$/, TOKEN_ENV = /^AFFILIATE_TOKEN_[A-Z0-9_]{1,48}$/
const ORIGIN = /^src_[a-z0-9]{1,16}$/, STORE = /^store_[0-9]{1,3}$/, KID = /^k_[a-z0-9]{1,16}$/
export type BatchConfig = { keys: CommissionKey[]; tokens: { digest: Buffer; origin: string }[]; receiptKey: Buffer }
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const send = (reply: FastifyReply, status: number, code: string, message: string, detail?: string) =>
  reply.code(status).send({ error: { code, message, details: detail ? { detail } : {} } })

/** Content-Length declarado, sem confiar nele: presente/ausente, valor em bytes quando é um inteiro seguro (cabe no bigint), senão só o texto. */
export function declaredLength(header: unknown): { present: boolean; bytes: number | null; raw: string } {
  const raw = Array.isArray(header) ? String(header[0] ?? '') : header === undefined || header === null ? '' : String(header)
  if (!raw.trim()) return { present: false, bytes: null, raw: '' }
  const digits = /^[0-9]{1,30}$/.test(raw.trim()) ? raw.trim() : null
  const n = digits === null ? NaN : Number(digits)
  return { present: true, bytes: Number.isSafeInteger(n) ? n : null, raw: raw.slice(0, 40) }
}

/** AFFILIATE_KEYS_JSON = {"k_x":{"env":"AFFILIATE_KEY_X","origin":"src_..","stores":["store_1"]}};
 *  AFFILIATE_TOKENS_JSON = [{"env":"AFFILIATE_TOKEN_X","origin":"src_.."}]; AFFILIATE_RECEIPT_KEY = segredo (>= 32 bytes). */
export function batchConfig(env: Readonly<Record<string, string | undefined>>): BatchConfig | null {
  try {
    const kr = JSON.parse(env.AFFILIATE_KEYS_JSON ?? 'null'), tk = JSON.parse(env.AFFILIATE_TOKENS_JSON ?? 'null'), rk = env.AFFILIATE_RECEIPT_KEY
    if (!isObj(kr) || !Array.isArray(tk) || !tk.length || typeof rk !== 'string' || Buffer.byteLength(rk) < 32) return null
    const keys: CommissionKey[] = []
    for (const [key_id, e] of Object.entries(kr)) {
      if (!KID.test(key_id) || !isObj(e) || Object.keys(e).sort().join() !== 'env,origin,stores' || !KEY_ENV.test(e.env) || !ORIGIN.test(e.origin) ||
        !Array.isArray(e.stores) || !e.stores.length || !e.stores.every((s: unknown) => typeof s === 'string' && STORE.test(s))) return null
      const secret = env[e.env]; if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) return null
      keys.push({ key_id, scope: 'commission', origin: e.origin, stores: Object.freeze([...e.stores]), secret: Buffer.from(secret) })
    }
    const tokens = []
    for (const t of tk) {
      if (!isObj(t) || Object.keys(t).sort().join() !== 'env,origin' || !TOKEN_ENV.test(t.env) || !ORIGIN.test(t.origin)) return null
      const secret = env[t.env]; if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(secret)) return null
      tokens.push({ digest: digest(secret), origin: t.origin })
    }
    return { keys, tokens, receiptKey: Buffer.from(rk) }
  } catch { return null }
}

/** Mapa corrente -> lojista: AFFILIATE_STREAMS_JSON = {"src_odin|store_1":"mer_..."}. Inválido = nenhum mapeamento (aplicação espera, com motivo). */
export function streamMap(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  try {
    const m = JSON.parse(env.AFFILIATE_STREAMS_JSON ?? '{}')
    if (!isObj(m)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(m)) if (/^src_[a-z0-9]{1,16}\|store_[0-9]{1,3}$/.test(k) && typeof v === 'string' && /^mer_[0-9A-Z]{26}$/.test(v)) out[k] = v
    return out
  } catch { return {} }
}

export function registerCommissionBatches(app: FastifyInstance, ctx: Ctx, env: Readonly<Record<string, string | undefined>>): void {
  if (!ctx.affiliates) return
  const config = batchConfig(env)
  app.register(async scope => {
    // Só application/json entra neste escopo: os parsers herdados (text/plain etc.) são removidos para que qualquer outro media type
    // seja 415 commission_content_type ANTES de qualquer leitura, e nunca um corpo em string classificado como "tamanho".
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: MAX_BATCH_BYTES }, (_req, body, done) => done(null, body))
    // Toda recusa de lote vira uma linha durável (affiliate_commission_rejections): o produtor e uma pessoa veem o que foi recusado e por quê.
    // Corpo inteiro em mãos = sha e tamanho medidos (capture full); corpo não lido (413/415/erro do parser, antes do handler) = só o
    // Content-Length declarado (capture declared) ou nada (none, p.ex. chunked); nunca o sha de um Buffer vazio apresentado como corpo.
    // O tamanho declarado é gravado como bigint; um valor que nem cabe num inteiro seguro fica registrado no detalhe, com bytes nulo.
    const rejected = async (req: any, http: number, code: string, detail: string | undefined, origin: string | null) => {
      const keyId = String(req.headers?.['x-pixsettle-key-id'] ?? '').slice(0, 64) || null
      const body = Buffer.isBuffer(req.body) ? req.body : null
      const declared = declaredLength(req.headers?.['content-length'])
      const capture = body ? 'full' : declared.present ? 'declared' : 'none'
      const note = !body && declared.present && declared.bytes === null ? `content-length declarado não representável: ${declared.raw}` : null
      const fullDetail = [detail, note].filter(Boolean).join('; ').slice(0, 300) || null
      try {
        await ctx.db.query(`INSERT INTO affiliate_commission_rejections (origin, key_id, code, detail, http, capture, body_sha256, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [origin, keyId, code, fullDetail, http, capture, body ? createHash('sha256').update(body).digest('hex') : null, body ? body.length : capture === 'declared' ? declared.bytes : null])
      } catch (e) { req.log.error({ err: e, code, http, capture }, 'não gravou a recusa do lote (auditoria perdida)') }
    }
    scope.setErrorHandler(async (error: any, req, reply) => {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') { await rejected(req, 413, 'commission_batch_size', 'lote maior que 4 MiB', null); return send(reply, 413, 'commission_batch_size', 'lote maior que 4 MiB') }
      if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') { await rejected(req, 415, 'commission_content_type', String(req.headers['content-type'] ?? '').slice(0, 100), null); return send(reply, 415, 'commission_content_type', 'use application/json') }
      req.log.error({ err: error }, 'ingestão de comissões falhou antes do handler')
      await rejected(req, 503, 'commission_unavailable', String(error?.code ?? error?.message ?? '').slice(0, 200), null)
      return send(reply, 503, 'commission_unavailable', 'ingestão temporariamente indisponível')
    })
    scope.post('/batches', async (req, reply) => {
      if (!config) { await rejected(req, 503, 'commission_not_configured', undefined, null); return send(reply, 503, 'commission_not_configured', 'chaves de ingestão de comissões não configuradas') }
      if (ctx.affiliates?.writes === false) { await rejected(req, 403, 'commission_read_only', undefined, null); return send(reply, 403, 'commission_read_only', 'esta instalação é réplica pública somente leitura: lotes de comissões não são aceitos aqui') }
      const auth = /^Bearer ([\x21-\x7e]{32,512})$/.exec(String(req.headers.authorization ?? ''))?.[1]
      const token = auth ? config.tokens.find(t => timingSafeEqual(t.digest, digest(auth))) : undefined
      if (!token) { await rejected(req, 401, 'commission_unauthorized', undefined, null); return send(reply, 401, 'commission_unauthorized', 'token ausente ou inválido') }
      // Defesa em profundidade: só um Buffer (application/json cru) chega à validação; nada em string vira "tamanho" ou "assinatura".
      if (!Buffer.isBuffer(req.body)) { await rejected(req, 415, 'commission_content_type', String(req.headers['content-type'] ?? '').slice(0, 100), token.origin); return send(reply, 415, 'commission_content_type', 'use application/json') }
      try {
        const keys = config.keys.filter(k => k.origin === token.origin)
        const v = validateBatch(req.body as Buffer, String(req.headers['x-pixsettle-key-id'] ?? ''), keys)
        const r = await ingestCommissionBatch(ctx.db, v, config.receiptKey)
        return reply.code(200).header('x-pixsettle-replayed', String(r.replayed)).send(r.receipt)
      } catch (e) {
        if (e instanceof CommissionError) {
          req.log.warn({ code: e.code, detail: e.detail }, 'lote de comissões recusado')
          await rejected(req, e.http, e.code, e.detail || undefined, token.origin)
          return send(reply, e.http, e.code, 'lote de comissões recusado', e.detail || undefined)
        }
        req.log.error({ err: e }, 'ingestão de comissões falhou')
        await rejected(req, 503, 'commission_unavailable', (e as Error).message?.slice(0, 200), token.origin)
        return send(reply, 503, 'commission_unavailable', 'ingestão temporariamente indisponível')
      }
    })
  }, { prefix: '/pilot/affiliates/v1' })
}
