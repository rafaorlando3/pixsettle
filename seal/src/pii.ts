// Personal-data scanner, twin of python/pbp_seal/pii.py. A record with personal data is never sealed.
// Findings carry a diagnostic path and the kind, never a personal value or key.
import { isJsonArray, isJsonObject } from './json.js'

export type Finding = { path: string; kind: string }

const CPF = /(?<!\d)(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?!\d)/g
const CNPJ = /(?<!\d)(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})(?!\d)/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/
const PHONE = /(\+\s?55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4})|(\(\d{2}\)\s?9?\d{4}-\d{4})|(\+\s?595\s?\(?\d{2,3}\)?\s?\d{3}[-\s]?\d{3,4})/
const UUID4 = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/

const digits = (s: string) => [...s].filter(c => c >= '0' && c <= '9').map(Number)

function cpfOk(s: string): boolean {
  const d = digits(s)
  if (d.length !== 11 || new Set(d).size === 1) return false
  for (const n of [9, 10]) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += d[i]! * (n + 1 - i)
    if (((sum * 10) % 11) % 10 !== d[n]) return false
  }
  return true
}

function cnpjOk(s: string): boolean {
  const d = digits(s)
  if (d.length !== 14 || new Set(d).size === 1) return false
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const w2 = [6, ...w1]
  for (const [w, n] of [[w1, 12], [w2, 13]] as const) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += d[i]! * w[i]!
    const r = sum % 11
    if ((r < 2 ? 0 : 11 - r) !== d[n]) return false
  }
  return true
}

function scanText(text: string, keyHint: string): string[] {
  const kinds: string[] = []
  if ([...text.matchAll(CPF)].some(m => cpfOk(m[1]!))) kinds.push('cpf')
  if ([...text.matchAll(CNPJ)].some(m => cnpjOk(m[1]!))) kinds.push('cnpj')
  if (EMAIL.test(text)) kinds.push('email')
  if (PHONE.test(text)) kinds.push('phone')
  if ((keyHint.includes('pix') || keyHint.includes('key') || keyHint.includes('chave')) && UUID4.test(text)) kinds.push('pix_random_key')
  return kinds
}

// Preserve safe legacy paths; arbitrary or personal keys use a closed segment.
export function diagnosticKeyPath(path: string, key: string): string {
  const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && scanText(key, '').length === 0
  return safe ? `${path}.${key}` : `${path}[redacted_key]`
}

export function scanPii(v: unknown, path = '$', keyHint = ''): Finding[] {
  const out: Finding[] = []
  if (typeof v === 'string') out.push(...scanText(v, keyHint).map(kind => ({ path, kind })))
  else if (isJsonArray(v)) v.forEach((x, i) => out.push(...scanPii(x, `${path}[${i}]`, keyHint)))
  else if (isJsonObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      const childPath = diagnosticKeyPath(path, k)
      out.push(...scanText(k, '').map(kind => ({ path: childPath, kind })))
      out.push(...scanPii(x, childPath, k.toLowerCase()))
    }
  }
  return out
}
