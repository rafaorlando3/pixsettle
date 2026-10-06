// Guarda de ingestão dos eventos atestados: forma fechada (só chaves conhecidas), sem dado pessoal.
// Recusa com motivo; nunca "limpa" silenciosamente.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import canonicalizeLib from 'canonicalize'
const canonicalize = canonicalizeLib as unknown as (v: unknown) => string | undefined

export const ALLOWED_KEYS = new Set([
  'ev', 'ts', 'store', 'ord', 'chg', 'wd', 'amt', 'cur', 'amt_usd', 'price_cur', 'fx', 'credit', 'meth', 'src', 'partner_store',
  'st', 'pay', 'chk', 'fin', 'settled', 'how', 'by', 'prov', 'exp', 'late', 'handled', 'rcv', 'fee', 'net', 'req', 'dir',
])
const FORBIDDEN_KEY = /^(name|nome|payer|pagador|document|documento|cpf|cnpj|email|e_mail|phone|telefone|fone|address|endereco|endereço|holder|receiver|product|produto|slug|qr|copy|raw|key|token|secret)/i
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const CPF = /\d{3}\.\d{3}\.\d{3}-\d{2}/
const LONG_DIGITS = /(?<![\d:T-])\d{10,}(?!\d)/
const EV = /^[a-z_]+(\.[a-z_]+){1,3}$/
const STORE = /^[a-z0-9-]{1,40}$/
const PSEUDO = /^[a-z]_[a-z]{8,40}$/
const AMOUNT = /^-?\d{1,12}\.\d{2}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export type AttestedLine = Record<string, string | number | null>
export type GuardResult = { ok: true; line: AttestedLine; key: string } | { ok: false; reason: string }

export function guardLine(raw: unknown): GuardResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'line_not_object' }
  const line = raw as Record<string, unknown>
  const keys = Object.keys(line)
  if (keys.length > 40) return { ok: false, reason: 'too_many_keys' }
  for (const k of keys) {
    if (FORBIDDEN_KEY.test(k)) return { ok: false, reason: `forbidden_key:${k}` }
    if (!ALLOWED_KEYS.has(k)) return { ok: false, reason: `unknown_key:${k}` }
    const v = line[k]
    if (v === null) continue
    if (typeof v === 'number') { if (!Number.isFinite(v)) return { ok: false, reason: `non_finite:${k}` }; continue }
    if (typeof v !== 'string') return { ok: false, reason: `bad_type:${k}` }
    if (v.length > 200) return { ok: false, reason: `too_long:${k}` }
    if (EMAIL.test(v)) return { ok: false, reason: `looks_like_email:${k}` }
    if (CPF.test(v)) return { ok: false, reason: `looks_like_cpf:${k}` }
    if (LONG_DIGITS.test(v)) return { ok: false, reason: `long_digit_run:${k}` }
  }
  const ev = line.ev, ts = line.ts, store = line.store
  if (typeof ev !== 'string' || !EV.test(ev)) return { ok: false, reason: 'ev_invalid' }
  if (ts !== null && ts !== undefined && (typeof ts !== 'string' || !ISO.test(ts))) return { ok: false, reason: 'ts_invalid' }
  if (typeof store !== 'string' || !STORE.test(store)) return { ok: false, reason: 'store_invalid' }
  for (const k of ['ord', 'chg', 'wd', 'partner_store'] as const) {
    const v = line[k]
    if (v !== null && v !== undefined && (typeof v !== 'string' || !(k === 'partner_store' ? STORE : PSEUDO).test(v))) return { ok: false, reason: `${k}_invalid` }
  }
  for (const k of ['amt', 'rcv', 'fee', 'net', 'credit', 'amt_usd', 'fx'] as const) {
    const v = line[k]
    if (v !== null && v !== undefined && (typeof v !== 'string' || !AMOUNT.test(v))) return { ok: false, reason: `${k}_invalid` }
  }
  for (const k of ['exp', 'req', 'settled', 'handled'] as const) {
    const v = line[k]
    if (v !== null && v !== undefined && (typeof v !== 'string' || !ISO.test(v))) return { ok: false, reason: `${k}_invalid` }
  }
  const key = createHash('sha256').update(canonicalize(line) ?? '').digest('hex')
  return { ok: true, line: line as AttestedLine, key }
}

/** Assinatura do lote: HMAC-SHA256 do corpo bruto com o segredo compartilhado (header x-pilot-signature: sha256=<hex>). */
export function signBody(secret: string, rawBody: string | Buffer): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
}
export function verifySignature(secret: string, rawBody: string | Buffer, header: string | undefined): { ok: boolean; reason: string } {
  if (!secret) return { ok: false, reason: 'server_secret_missing' }
  if (!header || !header.startsWith('sha256=')) return { ok: false, reason: 'signature_header_missing' }
  const exp = Buffer.from(signBody(secret, rawBody)), got = Buffer.from(header)
  if (exp.length !== got.length || !timingSafeEqual(exp, got)) return { ok: false, reason: 'signature_mismatch' }
  return { ok: true, reason: 'ok' }
}

/** "1234.56" -> 123456n (centavos), exato, sem ponto flutuante. */
export function toMinor(amount: string | number | null | undefined): bigint | null {
  if (amount === null || amount === undefined) return null
  const s = String(amount)
  const m = /^(-?)(\d{1,12})\.(\d{2})$/.exec(s)
  if (!m) return null
  const v = BigInt(m[2]!) * 100n + BigInt(m[3]!)
  return m[1] === '-' ? -v : v
}
