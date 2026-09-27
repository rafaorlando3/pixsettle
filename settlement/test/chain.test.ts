import { describe, it, expect } from 'vitest'
import { encodeAbiParameters, pad, type Hex } from 'viem'
import { memoFromSettlementId, settlementIdFromMemo, classifyBroadcastError, checkIdentity, TRANSFER_WITH_MEMO_TOPIC, type TransferIntent } from '../src/chain.js'

const intent: TransferIntent = {
  chainId: 42431, token: '0x20c0000000000000000000000000000000000000',
  from: '0x0f99c00f2712E562B4e762aD11b6b6841557ed14', to: '0x8ee643c15C603856A76d05020b5ccB0FceA425BF',
  amount: 16436610n, memo: memoFromSettlementId('stl_01K6V9C7R4000000000000000A'),
}
const log = (o: Partial<{ address: Hex; from: Hex; to: Hex; memo: Hex; amount: bigint }> = {}) => ({
  address: o.address ?? intent.token,
  topics: [TRANSFER_WITH_MEMO_TOPIC, pad(o.from ?? intent.from), pad(o.to ?? intent.to), o.memo ?? intent.memo] as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }], [o.amount ?? intent.amount]), logIndex: 1,
})
const rcpt = (logs: ReturnType<typeof log>[], status: 'success' | 'reverted' = 'success') =>
  ({ status, blockNumber: 1n, blockHash: ('0x' + '11'.repeat(32)) as Hex, transactionHash: ('0x' + '22'.repeat(32)) as Hex, logs })

describe('memo', () => {
  it('codifica o settlement_id em 32 bytes com zeros à direita e volta', () => {
    const m = memoFromSettlementId('stl_01K6V9C7R4000000000000000A')
    expect(m).toMatch(/^0x[0-9a-f]{64}$/)
    expect(m.endsWith('0000')).toBe(true)
    expect(settlementIdFromMemo(m)).toBe('stl_01K6V9C7R4000000000000000A')
  })
  it('recusa id fora do formato', () => { expect(() => memoFromSettlementId('ord_x')).toThrow() })
})

describe('classificação do reenvio (observado na Moderato)', () => {
  it('already known -> reconciliar', () => { expect(classifyBroadcastError({ details: 'already known' })).toMatchObject({ kind: 'reconcile', reason: 'already_known' }) })
  it('nonce too low -> reconciliar', () => { expect(classifyBroadcastError({ details: 'nonce too low: next nonce 3, tx nonce 2' })).toMatchObject({ kind: 'reconcile', reason: 'nonce_too_low' }) })
  it('timeout -> desconhecido, nunca falha', () => { expect(classifyBroadcastError({ name: 'TimeoutError', message: 'The request took too long' })).toMatchObject({ kind: 'unknown' }) })
  it('outro erro -> rejeitado com detalhe', () => { expect(classifyBroadcastError({ details: 'insufficient funds for gas' })).toMatchObject({ kind: 'rejected', detail: 'insufficient funds for gas' }) })
})

describe('identidade do evento (seção 4.8)', () => {
  it('evento exato confere', () => { expect(checkIdentity(intent, rcpt([log()]), 42431)).toMatchObject({ identityOk: true, logIndex: 1 }) })
  it('mesmo memo em outro token não conta', () => { expect(checkIdentity(intent, rcpt([log({ address: '0x20c0000000000000000000000000000000000001' })]), 42431).identityOk).toBe(false) })
  it('mesmo memo com outro remetente não conta', () => { expect(checkIdentity(intent, rcpt([log({ from: '0x000000000000000000000000000000000000dEaD' })]), 42431).identityOk).toBe(false) })
  it('mesmo memo com outro destino não conta', () => { expect(checkIdentity(intent, rcpt([log({ to: '0x000000000000000000000000000000000000dEaD' })]), 42431).identityOk).toBe(false) })
  it('mesmo memo com outro valor não conta', () => { expect(checkIdentity(intent, rcpt([log({ amount: 1n })]), 42431).identityOk).toBe(false) })
  it('outra rede não conta', () => { expect(checkIdentity(intent, rcpt([log()]), 4217).identityOk).toBe(false) })
  it('recibo revertido não conta', () => { expect(checkIdentity(intent, rcpt([log()], 'reverted'), 42431).mismatches).toContain('recibo revertido') })
})
