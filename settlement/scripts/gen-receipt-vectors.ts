// Gera contract/vectors/receipt-v1.json. Chave de TESTE pública (conta #0 do Hardhat): nunca usar com fundos.
import { writeFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { signReceipt, canonicalJson, buildMessage, type ReceiptPayload, type ReceiptEnvelope } from '../src/receipt.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const issuer = privateKeyToAccount(TEST_KEY).address
const other = privateKeyToAccount(OTHER_KEY).address

const base = (over: Record<string, unknown>): ReceiptPayload => ({
  schema_version: 1, receipt_id: 'rct_01K6VECTOR00000000000000A', receipt_type: 'settlement',
  issuer: { id: 'pixsettle-test', address: issuer }, provider_env: 'sandbox', chain_env: 'testnet', chain_id: 42431,
  order: { id: 'ord_01K6VECTOR00000000000000A', amount: { amount: '10090', currency: 'BRL', scale: 2 } },
  issued_at: '2026-09-27T05:00:00Z',
  token: '0x20c0000000000000000000000000000000000000', treasury: '0x0f99c00f2712E562B4e762aD11b6b6841557ed14',
  pix: { provider: 'asaas', state: 'received', observed_at: '2026-09-27T04:59:00Z' },
  quote: { id: 'quo_01K6VECTOR00000000000000A', rate_num: '181', rate_den: '1000', valid_until: '2026-09-27T05:10:00Z', rounding: 'floor' },
  amounts: { gross: '18262900', fees_simulated: '0', reserve_simulated: '1826290', net: '16436610', currency: 'pathUSD', scale: 6 },
  settlement: { to: '0x8ee643c15C603856A76d05020b5ccB0FceA425BF', amount: '16436610', memo: '0x73746c5f30314b365350494b4554455354303030303030303030303030000000', tx_hash: '0x55a434d33c9fa17da76ae4f4b0ea23d3030dada1639a1de584fcb5485d8290cb', block_number: '37086795', block_hash: '0x' + '11'.repeat(32), log_index: 1, confirmation_observed_at: '2026-09-27T05:00:00Z' },
  ...over,
}) as ReceiptPayload

const cases: { name: string; payload: ReceiptPayload }[] = [
  { name: 'settlement_basic', payload: base({}) },
  { name: 'unicode_and_key_order', payload: base({ zeta: 'último', 'é': 'ação ✓ 𝄞 😀', alpha: { 'ñ': ' linha', b: '"aspas" \\ barra /' } }) },
  { name: 'big_number_as_string', payload: base({ amounts: { gross: '123456789012345678901234567890', fees_simulated: '0', reserve_simulated: '0', net: '123456789012345678901234567890', currency: 'pathUSD', scale: 6 } }) },
  { name: 'refund_notice_without_onchain', payload: (() => { const p = base({ receipt_type: 'refund_notice', receipt_id: 'rct_01K6VECTOR00000000000000B', refund: { amount: '10090', currency: 'BRL', refund_type: 'late_payment_refund', state: 'confirmed', observed_at: '2026-09-27T05:30:00Z', source: 'provider_attested' } }) as Record<string, unknown>; for (const k of ['token', 'treasury', 'pix', 'quote', 'amounts', 'settlement']) delete p[k]; return p as ReceiptPayload })() },
]

const valid = [] as unknown[]
for (const c of cases) {
  const env = await signReceipt(c.payload, TEST_KEY)
  valid.push({ name: c.name, jcs: canonicalJson(c.payload), digest_hex: env.digest.hex, message: buildMessage(c.payload, env.digest.hex), envelope: env })
}
const first = (valid[0] as { envelope: ReceiptEnvelope }).envelope
const tamperedPayload: ReceiptEnvelope = structuredClone(first); (tamperedPayload.payload as any).settlement.amount = '99999999'
const tamperedWithDigest: ReceiptEnvelope = structuredClone(tamperedPayload)
tamperedWithDigest.digest.hex = (await import('../src/receipt.js')).digestHex(tamperedWithDigest.payload)
const unknownIssuer = await signReceipt(base({ issuer: { id: 'intruso', address: other } }), OTHER_KEY)
const signerMismatch: ReceiptEnvelope = structuredClone(first); signerMismatch.signature.signer = other

const invalid = [
  { name: 'tampered_payload', expect: 'digest_mismatch', envelope: tamperedPayload },
  { name: 'tampered_payload_and_digest', expect: 'bad_signature', envelope: tamperedWithDigest },
  { name: 'unknown_issuer', expect: 'untrusted_issuer', envelope: unknownIssuer },
  { name: 'signer_field_mismatch', expect: 'bad_signature', envelope: signerMismatch },
]
const duplicateKeyJson = '{"a":1,"b":{"x":"1","x":"2"}}'

writeFileSync(new URL('../../contract/vectors/receipt-v1.json', import.meta.url), JSON.stringify({
  note: 'Vetores do recibo PixSettle v1. Chaves de TESTE públicas (Hardhat #0 e #1): nunca usar com fundos.',
  trusted_issuers: [issuer],
  test_private_key: TEST_KEY,
  valid, invalid,
  duplicate_key_json: { text: duplicateKeyJson, expect: 'duplicate_key' },
}, null, 2) + '\n')
console.log('ok', valid.length, 'válidos,', invalid.length, 'inválidos; emissor', issuer)
