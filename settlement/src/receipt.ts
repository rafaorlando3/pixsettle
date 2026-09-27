// Recibo verificável do PixSettle (contrato v0.3, seção 7).
// Mesmo algoritmo do lado PHP (core/app/Receipts). Qualquer mudança aqui exige
// regenerar contract/vectors/receipt-v1.json e rodar os testes dos dois lados.
import { createHash } from 'node:crypto'
import canonicalizeLib from 'canonicalize'
import { recoverMessageAddress, getAddress, isAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const canonicalize = canonicalizeLib as unknown as (v: unknown) => string | undefined

export const RECEIPT_SCHEMA_VERSION = 1
export const SIGNATURE_SCHEME = 'eip191-0x45'

export type ReceiptPayload = Record<string, unknown> & {
  schema_version: number
  receipt_id: string
  receipt_type: 'settlement' | 'refund_notice'
  issuer: { id: string; address: string }
  provider_env: string
  chain_env: string
  chain_id: number
}

export type ReceiptEnvelope = {
  payload: ReceiptPayload
  digest: { alg: 'sha256'; hex: string }
  signature: { scheme: typeof SIGNATURE_SCHEME; signer: string; value: Hex }
}

export class ReceiptError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`)
  }
}

/** Garante que só existam tipos que o JCS serializa sem ambiguidade entre linguagens. */
function assertCanonicalSafe(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ReceiptError('invalid_number', `${path} deve ser inteiro seguro; dinheiro vai como string decimal`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertCanonicalSafe(v, `${path}[${i}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) throw new ReceiptError('invalid_value', `${path}.${k} é undefined`)
      assertCanonicalSafe(v, `${path}.${k}`)
    }
    return
  }
  throw new ReceiptError('invalid_value', `${path} tem tipo não suportado (${typeof value})`)
}

/** JCS (RFC 8785). */
export function canonicalJson(value: unknown): string {
  assertCanonicalSafe(value)
  const out = canonicalize(value)
  if (out === undefined) throw new ReceiptError('invalid_value', 'payload não serializável')
  return out
}

export function digestHex(payload: unknown): string {
  return createHash('sha256').update(Buffer.from(canonicalJson(payload), 'utf8')).digest('hex')
}

/** Mensagem assinada: LF reais, sem quebra final. */
export function buildMessage(payload: ReceiptPayload, digest: string): string {
  return [
    'PixSettle receipt v1',
    `provider_env=${payload.provider_env}`,
    `chain_env=${payload.chain_env}`,
    `chain_id=${payload.chain_id}`,
    `digest=${digest}`,
  ].join('\n')
}

const COMMON_FIELDS = ['schema_version', 'receipt_id', 'receipt_type', 'issuer', 'provider_env', 'chain_env', 'chain_id', 'order', 'issued_at']
const TYPE_FIELDS: Record<string, string[]> = {
  settlement: ['token', 'treasury', 'pix', 'quote', 'amounts', 'settlement'],
  refund_notice: ['refund'],
}

export function validatePayload(p: Record<string, unknown>): asserts p is ReceiptPayload {
  for (const f of COMMON_FIELDS) if (!(f in p)) throw new ReceiptError('missing_field', f)
  if (p.schema_version !== RECEIPT_SCHEMA_VERSION) throw new ReceiptError('unsupported_schema', String(p.schema_version))
  const type = p.receipt_type as string
  const extra = TYPE_FIELDS[type]
  if (!extra) throw new ReceiptError('invalid_receipt_type', String(type))
  for (const f of extra) if (!(f in p)) throw new ReceiptError('missing_field', `${type}.${f}`)
  if (type === 'refund_notice') {
    // Sem liquidação on-chain anterior não se inventa tx: só com settlement_ref.
    if ('settlement' in p) throw new ReceiptError('invalid_field', 'refund_notice não carrega settlement; use settlement_ref')
  }
  const issuer = p.issuer as { address?: unknown }
  if (typeof issuer?.address !== 'string' || !isAddress(issuer.address)) throw new ReceiptError('invalid_field', 'issuer.address')
  if (!Number.isSafeInteger(p.chain_id)) throw new ReceiptError('invalid_field', 'chain_id')
}

export async function signReceipt(payload: ReceiptPayload, privateKey: Hex): Promise<ReceiptEnvelope> {
  validatePayload(payload)
  const account = privateKeyToAccount(privateKey)
  if (getAddress(payload.issuer.address) !== account.address) {
    throw new ReceiptError('issuer_mismatch', 'issuer.address diferente da chave de assinatura')
  }
  const hex = digestHex(payload)
  const value = await account.signMessage({ message: buildMessage(payload, hex) })
  return { payload, digest: { alg: 'sha256', hex }, signature: { scheme: SIGNATURE_SCHEME, signer: account.address, value } }
}

export type VerifyResult = { ok: true; recovered: string } | { ok: false; code: string; detail: string }

/** Seção 7.3, passos 1 a 3 (o passo 4, conferência na RPC, fica no verificador de cadeia). */
export async function verifyEnvelope(env: ReceiptEnvelope, trustedIssuers: string[]): Promise<VerifyResult> {
  try {
    validatePayload(env.payload)
    if (env.digest?.alg !== 'sha256') return { ok: false, code: 'unsupported_digest', detail: String(env.digest?.alg) }
    if (env.signature?.scheme !== SIGNATURE_SCHEME) return { ok: false, code: 'unsupported_scheme', detail: String(env.signature?.scheme) }
    const recomputed = digestHex(env.payload)
    if (recomputed !== env.digest.hex) return { ok: false, code: 'digest_mismatch', detail: `esperado ${recomputed}` }
    const recovered = await recoverMessageAddress({ message: buildMessage(env.payload, recomputed), signature: env.signature.value })
    const signer = getAddress(env.signature.signer)
    const issuer = getAddress(env.payload.issuer.address)
    if (recovered !== signer) return { ok: false, code: 'bad_signature', detail: `recuperado ${recovered}` }
    if (signer !== issuer) return { ok: false, code: 'issuer_mismatch', detail: `signer ${signer} != issuer ${issuer}` }
    if (!trustedIssuers.map(a => getAddress(a)).includes(recovered)) return { ok: false, code: 'untrusted_issuer', detail: recovered }
    return { ok: true, recovered }
  } catch (e) {
    if (e instanceof ReceiptError) return { ok: false, code: e.code, detail: e.message }
    return { ok: false, code: 'verify_error', detail: (e as Error).message }
  }
}

/**
 * JSON.parse sem aceitar chaves duplicadas (JSON.parse comum fica com a última em silêncio).
 * Parser mínimo e estrito, só para validar; o objeto final vem do JSON.parse.
 */
export function parseStrict(text: string): unknown {
  let i = 0
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++ }
  const fail = (m: string): never => { throw new ReceiptError('invalid_json', `${m} na posição ${i}`) }
  const str = (): string => {
    const start = i
    if (text[i] !== '"') fail('esperava string')
    i++
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++ }
    if (text[i] !== '"') fail('string sem fim')
    i++
    return JSON.parse(text.slice(start, i)) as string
  }
  const val = (): void => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++; ws()
      const seen = new Set<string>()
      if (text[i] === '}') { i++; return }
      for (;;) {
        ws(); const k = str()
        if (seen.has(k)) throw new ReceiptError('duplicate_key', k)
        seen.add(k)
        ws(); if (text[i] !== ':') fail('esperava :'); i++
        val(); ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return }
        fail('esperava , ou }')
      }
    }
    if (c === '[') {
      i++; ws()
      if (text[i] === ']') { i++; return }
      for (;;) { val(); ws(); if (text[i] === ',') { i++; continue } if (text[i] === ']') { i++; return } fail('esperava , ou ]') }
    }
    if (c === '"') { str(); return }
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i))
    if (!m) fail('valor inválido')
    i += m![0].length
  }
  val(); ws()
  if (i !== text.length) fail('conteúdo depois do fim')
  return JSON.parse(text)
}
