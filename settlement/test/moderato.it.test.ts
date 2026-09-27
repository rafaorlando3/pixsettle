// Integração real na Tempo Moderato. Roda só com TEMPO_IT=1 e TEMPO_IT_KEYS apontando para um
// arquivo local com chaves de TESTE ({treasury, merchant}); nunca commitar esse arquivo.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { tempoModerato } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { TempoChain, memoFromSettlementId, type TransferIntent } from '../src/chain.js'

const run = process.env.TEMPO_IT === '1'
describe.skipIf(!run)('Moderato: assinar, transmitir, reenviar, conferir', () => {
  it('fluxo completo com os mesmos bytes', async () => {
    const keys = JSON.parse(readFileSync(process.env.TEMPO_IT_KEYS!, 'utf8')) as { treasury: Hex; merchant: Hex }
    const chain = new TempoChain(tempoModerato)
    const from = privateKeyToAccount(keys.treasury).address, to = privateKeyToAccount(keys.merchant).address
    const sid = 'stl_01K6' + Date.now().toString(32).toUpperCase().replace(/[ILOU]/g, '0').padStart(22, '0').slice(-22)
    const intent: TransferIntent = { chainId: 42431, token: '0x20c0000000000000000000000000000000000000', from, to, amount: 1000n, memo: memoFromSettlementId(sid) }
    const startBlock = await chain.pub.getBlockNumber()
    const nonce = await chain.pendingNonce(from)
    const signed = await chain.signTransfer(keys.treasury, intent, nonce)
    expect(signed.nonce).toBe(nonce)
    await expect(chain.signTransfer(keys.merchant, intent, nonce)).rejects.toThrow(/tesouraria/)
    expect(await chain.observe(signed.hash, intent)).toBeNull() // assinada, ainda não transmitida
    const b1 = await chain.broadcast(signed.raw)
    expect(b1).toEqual({ kind: 'accepted', hash: signed.hash })
    const b2 = await chain.broadcast(signed.raw)
    expect(['accepted', 'reconcile']).toContain(b2.kind) // nunca "rejected" para os mesmos bytes
    await chain.pub.waitForTransactionReceipt({ hash: signed.hash })
    const obs = await chain.observe(signed.hash, intent)
    expect(obs).toMatchObject({ identityOk: true, status: 'success' })
    const byMemo = await chain.findByMemo(intent, startBlock)
    expect(byMemo).toHaveLength(1)
    const b3 = await chain.broadcast(signed.raw)
    expect(b3).toMatchObject({ kind: 'reconcile', reason: 'nonce_too_low' })
  }, 60_000)
})
