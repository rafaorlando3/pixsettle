import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { verifyEnvelope, canonicalJson, digestHex, buildMessage, parseStrict, signReceipt, ReceiptError, type ReceiptEnvelope } from '../src/receipt.js'

const V = JSON.parse(readFileSync(new URL('../../contract/vectors/receipt-v1.json', import.meta.url), 'utf8'))

describe('recibo: vetores comuns (contrato 7.3)', () => {
  for (const c of V.valid) {
    it(`válido: ${c.name}`, async () => {
      expect(canonicalJson(c.envelope.payload)).toBe(c.jcs)
      expect(digestHex(c.envelope.payload)).toBe(c.digest_hex)
      expect(buildMessage(c.envelope.payload, c.digest_hex)).toBe(c.message)
      expect(c.message.endsWith('\n')).toBe(false)
      const r = await verifyEnvelope(c.envelope, V.trusted_issuers)
      expect(r).toEqual({ ok: true, recovered: V.trusted_issuers[0] })
      // assinatura determinística (RFC 6979): assinar de novo dá os mesmos bytes
      const again = await signReceipt(c.envelope.payload, V.test_private_key)
      expect(again.signature.value).toBe(c.envelope.signature.value)
    })
  }
  for (const c of V.invalid) {
    it(`inválido: ${c.name} -> ${c.expect}`, async () => {
      const r = await verifyEnvelope(c.envelope as ReceiptEnvelope, V.trusted_issuers)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe(c.expect)
    })
  }
  it('JSON com chave duplicada é recusado', () => {
    expect(() => parseStrict(V.duplicate_key_json.text)).toThrowError(/duplicate_key/)
    expect(parseStrict('{"a":{"b":[1,{"c":"d"}]},"e":"f"}')).toEqual({ a: { b: [1, { c: 'd' }] }, e: 'f' })
  })
  it('número fracionário ou grande demais é recusado (dinheiro vai como string)', () => {
    expect(() => canonicalJson({ amount: 10.5 })).toThrowError(ReceiptError)
    expect(() => canonicalJson({ amount: 2 ** 60 })).toThrowError(/inteiro seguro/)
  })
  it('refund_notice não pode carregar settlement inventado', async () => {
    const env = V.valid.find((x: any) => x.name === 'refund_notice_without_onchain').envelope
    const bad = structuredClone(env); bad.payload.settlement = { tx_hash: '0x00' }
    const r = await verifyEnvelope(bad, V.trusted_issuers)
    expect(r.ok).toBe(false)
  })
})
