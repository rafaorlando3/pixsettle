// Rótulos dos números do pedido na demo (web/public/kpi.js).
import { describe, it, expect } from 'vitest'
// @ts-expect-error módulo JS do navegador, sem tipos
import { kpiLabels } from '../public/kpi.js'

const o = (status: string, extra: any = {}) => ({ status, hold_reason: null, settlement: null, ...extra })

describe('demo: números do pedido seguem o estado real', () => {
  it('aguardando pagamento: valor cobrado, envio e reserva só como projeção', () => {
    expect(kpiLabels(o('awaiting_payment'))).toMatchObject({ brl: 'Amount charged (BRL)', net: 'Merchant would get, if paid (pathUSD)', res: 'Reserve if paid (projected)' })
  })
  it('vencido sem pagamento: nunca "Pix received" nem "will get"; zera envio e reserva', () => {
    const k = kpiLabels(o('expired'))
    expect(k.brl).not.toMatch(/received/i)
    expect(k.net).not.toMatch(/will get/i)
    expect(k).toMatchObject({ sent: false, reserve: false })
  })
  it('retido: nada enviado', () => {
    expect(kpiLabels(o('paid', { hold_reason: 'amount_mismatch' }))).toMatchObject({ net: 'On hold, nothing sent', sent: false, reserve: false })
  })
  it('pago e liquidado: recebido, "will get" e depois "got"', () => {
    expect(kpiLabels(o('paid')).net).toBe('Merchant will get (pathUSD)')
    expect(kpiLabels(o('settled'))).toMatchObject({ brl: 'Pix received (BRL)', net: 'Merchant got (pathUSD)', sent: true })
  })
  it('pagamento atrasado: recebido, mas nada enviado (vai para devolução)', () => {
    expect(kpiLabels(o('late_paid'))).toMatchObject({ sent: false, reserve: false })
  })
  it('devolvido: com transação on-chain o lojista recebeu; sem transação, nada foi enviado', () => {
    expect(kpiLabels(o('refunded', { settlement: { tx_hash: '0x' + '1'.repeat(64) } })).net).toBe('Merchant got (pathUSD)')
    expect(kpiLabels(o('refunded')).net).toBe('Refunded, nothing sent')
  })
})
