// Piloto com eventos atestados + copiloto de exceções. Banco novo por teste, cadeia falsa, modelo programado.
import { describe, it, expect, afterEach } from 'vitest'
import { setup, settleAll } from './helpers.js'
import { guardLine, signBody, toMinor } from '../src/pilot/guard.js'
import { ingestBatch, processPending } from '../src/pilot/ingest.js'
import { buildApp } from '../src/app.js'
import { registerPilot, BATCH_CONTENT_TYPE, summary } from '../src/pilot/routes.js'
import { decideByOperator, judgeWithModel } from '../src/copilot/judge.js'
import { ScriptedModel, ReplayModel, RecordingModel } from '../src/copilot/model.js'
import { validateVerdict, canAutoApply } from '../src/copilot/verdict.js'
import { sweepNeeded } from '../src/flows/sweep.js'
import { drain } from '../src/outbox.js'
import { privateKeyToAccount } from 'viem/accounts'
import { signReceipt } from '../../settlement/src/receipt.js'

const ISSUER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const // chave pública de TESTE

const T0 = '2026-09-10T12:00:00Z'
const at = (min: number) => new Date(new Date(T0).getTime() + min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const order = (ord: string, amt: string, extra: Record<string, unknown> = {}) => ({ ev: 'order.created', ts: at(0), store: 'equilibrium', ord, amt, cur: 'BRL', meth: 'eulen', src: 'storefront', st: 'paid', pay: 'paid', ...extra })
const charge = (ord: string, chg: string, amt: string, min = 1) => ({ ev: 'pix.charge.created', ts: at(min), store: 'equilibrium', ord, chg, prov: 'eulen', meth: 'pix', amt, cur: 'BRL', exp: at(min + 60) })
const received = (ord: string, chg: string, amt: string, min = 5) => ({ ev: 'pix.received', ts: at(min), store: 'equilibrium', ord, chg, prov: 'eulen', meth: 'pix', amt, cur: 'BRL', late: 0 })
const chargeState = (ord: string, chg: string, st: string, min = 70) => ({ ev: `pix.charge.${st}`, ts: at(min), store: 'equilibrium', ord, chg, prov: 'eulen', meth: 'pix', amt: '100.00', cur: 'BRL' })

const drops: Array<() => Promise<void>> = []
afterEach(async () => { for (const d of drops.splice(0)) await d() })

async function env(model: any = null, over: Record<string, unknown> = {}) {
  const s = await setup()
  drops.push(s.drop)
  s.ctx.copilot = model ? { model } : { model: null, offReason: 'teste: COPILOT_MODE=off' }
  s.ctx.cfg.issuer = { id: 'pixsettle-test', address: privateKeyToAccount(ISSUER_KEY).address }
  s.chain.signReceipt = (payload: any) => signReceipt(payload, ISSUER_KEY)
  Object.assign(s.ctx.cfg, over)
  return s
}
async function load(ctx: any, lines: unknown[], batch = 'b1') {
  const ing = await ingestBatch(ctx, 'odin', batch, lines)
  const proc = await processPending(ctx, 'odin')
  return { ing, proc }
}
const exceptionsOf = (db: any, kind?: string) => db.query(`SELECT * FROM exceptions ${kind ? `WHERE kind='${kind}'` : ''} ORDER BY detected_at, id`).then((r: any) => r.rows)
const verdictsOf = (db: any, id: string) => db.query(`SELECT * FROM copilot_verdicts WHERE exception_id=$1 ORDER BY created_at`, [id]).then((r: any) => r.rows)

describe('guarda de ingestão (sem dado pessoal, forma fechada)', () => {
  it('recusa chave proibida, chave desconhecida, e-mail, CPF e sequência longa de dígitos, com o motivo', () => {
    expect(guardLine({ ...order('o_abcdefghij', '10.00'), payer_name: 'x' })).toMatchObject({ ok: false, reason: 'forbidden_key:payer_name' })
    expect(guardLine({ ...order('o_abcdefghij', '10.00'), extra: 'x' })).toMatchObject({ ok: false, reason: 'unknown_key:extra' })
    expect(guardLine({ ...order('o_abcdefghij', '10.00'), src: 'a@b.com' })).toMatchObject({ ok: false, reason: 'looks_like_email:src' })
    expect(guardLine({ ...order('o_abcdefghij', '10.00'), src: '123.456.789-01' })).toMatchObject({ ok: false, reason: 'looks_like_cpf:src' })
    expect(guardLine({ ...order('o_abcdefghij', '10.00'), src: '5567999998888' })).toMatchObject({ ok: false, reason: 'long_digit_run:src' })
    expect(guardLine({ ...order('ORD-1', '10.00') })).toMatchObject({ ok: false, reason: 'ord_invalid' })
    expect(guardLine({ ...order('o_abcdefghij', '10') })).toMatchObject({ ok: false, reason: 'amt_invalid' })
    expect(guardLine('texto')).toMatchObject({ ok: false, reason: 'line_not_object' })
  })
  it('aceita a linha certa e a chave é determinística', () => {
    const a = guardLine(order('o_abcdefghij', '10.00')), b = guardLine(order('o_abcdefghij', '10.00'))
    expect(a.ok && b.ok && a.key === b.key).toBe(true)
    expect(toMinor('1234.56')).toBe(123456n); expect(toMinor('-5.01')).toBe(-501n); expect(toMinor('1234.5')).toBeNull()
  })
})

describe('ingestão e conciliação de pedidos atestados', () => {
  it('pedido + cobrança + Pix recebido: pago, liquidado na cadeia falsa e com recibo; dedupe do lote', async () => {
    const { ctx, db, chain } = await env()
    const lines = [order('o_aaaaaaaaaa', '100.00'), charge('o_aaaaaaaaaa', 'i_aaaaaaaaaa', '100.00'), received('o_aaaaaaaaaa', 'i_aaaaaaaaaa', '100.00')]
    const r1 = await load(ctx, lines)
    expect(r1.ing).toMatchObject({ accepted: 3, duplicates: 0 }); expect(r1.proc.processed).toBe(3)
    const r2 = await load(ctx, lines, 'b2')
    expect(r2.ing).toMatchObject({ accepted: 0, duplicates: 3 })
    await settleAll(ctx, chain)
    const o = (await db.query(`SELECT status, paid_at, provider_env FROM orders`)).rows[0]
    expect(o.status).toBe('settled'); expect(o.provider_env).toBe('attested'); expect(new Date(o.paid_at).toISOString()).toBe(new Date(at(5)).toISOString())
    const rc = (await db.query(`SELECT receipt_type FROM receipts`)).rows
    expect(rc.map((r: any) => r.receipt_type)).toEqual(['settlement'])
    expect((await db.query(`SELECT * FROM pix_charges`)).rows[0]).toMatchObject({ provider: 'attested', provider_payment_id: 'i_aaaaaaaaaa', observed_state: 'received' })
    expect(await exceptionsOf(db)).toHaveLength(0)
    // a varredura periódica não tem trabalho com pedidos atestados
    expect(await sweepNeeded(ctx)).toBe(false)
  })

  it('evento fora de ordem (pagamento antes do pedido) é adiado e aplicado na mesma chamada', async () => {
    const { ctx, db } = await env()
    const r = await load(ctx, [received('o_bbbbbbbbbb', 'i_bbbbbbbbbb', '50.00'), charge('o_bbbbbbbbbb', 'i_bbbbbbbbbb', '50.00'), order('o_bbbbbbbbbb', '50.00')])
    expect(r.proc.processed).toBe(3)
    expect((await db.query(`SELECT status FROM orders`)).rows[0].status).toBe('settling')
    const st = (await db.query(`SELECT processing_state, count(*)::int AS n FROM attested_events GROUP BY 1`)).rows
    expect(st).toEqual([{ processing_state: 'processed', n: 3 }])
  })

  it('PILOT_SETTLE=0: pedido pago fica conciliado sem liquidação, com o motivo no histórico', async () => {
    const { ctx, db } = await env(null, { pilotSettle: false })
    await load(ctx, [order('o_cccccccccc', '10.00'), charge('o_cccccccccc', 'i_cccccccccc', '10.00'), received('o_cccccccccc', 'i_cccccccccc', '10.00')])
    expect((await db.query(`SELECT status FROM orders`)).rows[0].status).toBe('paid')
    expect((await db.query(`SELECT count(*)::int AS n FROM settlements`)).rows[0].n).toBe(0)
    expect((await db.query(`SELECT to_state FROM state_transitions WHERE entity='settlement_skipped'`)).rows[0].to_state).toBe('pilot_settlement_disabled')
  })

  it('3 cobranças, 1 paga: exceção duplicate_charge fechada pelas regras (close_benign_retry), sem modelo', async () => {
    const { ctx, db } = await env()
    await load(ctx, [order('o_dddddddddd', '100.00'), charge('o_dddddddddd', 'i_daaaaaaaaa', '100.00', 1), chargeState('o_dddddddddd', 'i_daaaaaaaaa', 'expired', 62),
      charge('o_dddddddddd', 'i_dbaaaaaaaa', '100.00', 63), chargeState('o_dddddddddd', 'i_dbaaaaaaaa', 'failed', 64), charge('o_dddddddddd', 'i_dcaaaaaaaa', '100.00', 65), received('o_dddddddddd', 'i_dcaaaaaaaa', '100.00', 66)])
    const ex = await exceptionsOf(db, 'duplicate_charge')
    expect(ex).toHaveLength(1)
    expect(ex[0]).toMatchObject({ status: 'resolved', copilot_state: 'rules_only' })
    expect(ex[0].resolution).toMatchObject({ action: 'close_benign_retry', by: 'auto' })
    const v = await verdictsOf(db, ex[0].id)
    expect(v.at(-1)).toMatchObject({ engine: 'rules', action: 'close_benign_retry', requires_human: false })
    // expiração e falha sem outra cobrança aberta viraram exceções informativas, fechadas na hora pelas regras (pedido sem pagamento)
    for (const kind of ['expired_unpaid', 'charge_failed']) {
      const x = await exceptionsOf(db, kind)
      expect(x).toHaveLength(1); expect(x[0].status).toBe('resolved'); expect(x[0].resolution).toMatchObject({ action: 'close_expired', by: 'auto' })
    }
    // a de cobranças repetidas foi reaberta a cada mudança e fechou como repetição benigna depois do pagamento
    const t = (await db.query(`SELECT to_state, reason FROM state_transitions WHERE entity='exception' AND entity_id=$1 ORDER BY id`, [ex[0].id])).rows
    expect(t[0].to_state).toBe('open'); expect(t.some((r: any) => r.to_state === 'awaiting_human')).toBe(true) // enquanto havia cobrança aberta, foi para o humano
    expect(t.at(-1).to_state).toBe('resolved'); expect(t.at(-1).reason).toContain('close_benign_retry') // pagou uma: fechou sozinha
    expect((await db.query(`SELECT count(*)::int AS n FROM pilot_charges`)).rows[0].n).toBe(3)
    expect((await db.query(`SELECT status FROM orders`)).rows[0].status).toBe('settling')
  })

  it('cobrança expirada sem pagamento: exceção expired_unpaid fechada pelas regras; pagamento depois reabre e encerra como superada', async () => {
    const { ctx, db } = await env()
    await load(ctx, [order('o_eeeeeeeeee', '30.00'), charge('o_eeeeeeeeee', 'i_eaaaaaaaaa', '30.00', 1), chargeState('o_eeeeeeeeee', 'i_eaaaaaaaaa', 'expired', 62)])
    let ex = await exceptionsOf(db, 'expired_unpaid')
    expect(ex[0]).toMatchObject({ status: 'resolved' }); expect(ex[0].resolution.action).toBe('close_expired')
    await load(ctx, [charge('o_eeeeeeeeee', 'i_ebaaaaaaaa', '30.00', 70), received('o_eeeeeeeeee', 'i_ebaaaaaaaa', '30.00', 71)], 'b2')
    expect((await db.query(`SELECT status FROM orders`)).rows[0].status).toBe('settling')
  })

  it('valor pago 1 centavo a menos: retenção amount_mismatch e hold_request_balance aplicado sozinho (reversível)', async () => {
    const { ctx, db } = await env()
    await load(ctx, [order('o_ffffffffff', '100.00'), charge('o_ffffffffff', 'i_ffffffffff', '100.00'), received('o_ffffffffff', 'i_ffffffffff', '99.99')])
    expect((await db.query(`SELECT status, hold_reason FROM orders`)).rows[0]).toMatchObject({ status: 'awaiting_payment', hold_reason: 'amount_mismatch' })
    const ex = await exceptionsOf(db, 'amount_mismatch')
    expect(ex[0]).toMatchObject({ status: 'auto_applied', copilot_state: 'rules_only', severity: 'high' })
    expect(ex[0].resolution.action).toBe('hold_request_balance')
    expect((await db.query(`SELECT count(*)::int AS n FROM settlements`)).rows[0].n).toBe(0)
  })

  it('diferença grande vai ao modelo: veredito válido gravado com hash; ação irreversível espera humano', async () => {
    const model = new ScriptedModel('scripted-1', () => '```json\n{"action":"refund_partial","confidence":0.82,"requires_human":true,"rationale":"The payer sent R$ 60.00 for a R$ 100.00 order; refunding the partial amount is the safest path.","evidence_refs":["e2","e1"]}\n```')
    const { ctx, db } = await env(model)
    await load(ctx, [order('o_gggggggggg', '100.00'), charge('o_gggggggggg', 'i_gggggggggg', '100.00'), received('o_gggggggggg', 'i_gggggggggg', '60.00')])
    let ex = (await exceptionsOf(db, 'amount_mismatch'))[0]
    expect(ex).toMatchObject({ status: 'open', copilot_state: 'pending_model' })
    expect(await drain(ctx)).toContain('copilot_judge')
    ex = (await exceptionsOf(db, 'amount_mismatch'))[0]
    expect(ex).toMatchObject({ status: 'awaiting_human', copilot_state: 'model_done', last_error: null })
    const v = (await verdictsOf(db, ex.id))[0]
    expect(v).toMatchObject({ engine: 'model', model: 'scripted-1', action: 'refund_partial', requires_human: true })
    expect(Number(v.confidence)).toBe(0.82); expect(v.verdict_hash).toMatch(/^[0-9a-f]{64}$/); expect(v.evidence_refs).toEqual(['e2', 'e1'])
    expect(model.calls[0]!.user).toContain('Allowed actions: hold_request_balance, refund_partial, refund_excess, accept_as_paid, escalate')
    // veredito é imutável
    await expect(db.query(`UPDATE copilot_verdicts SET action='accept_as_paid' WHERE id=$1`, [v.id])).rejects.toThrow(/append_only/)
  })

  it('modelo responde lixo: duas tentativas, depois model_error com o motivo, exceção aguardando humano', async () => {
    const model = new ScriptedModel('scripted-bad', () => 'I think you should refund. {"action": "refund_everything"}')
    const { ctx, db } = await env(model)
    await load(ctx, [order('o_hhhhhhhhhh', '100.00'), charge('o_hhhhhhhhhh', 'i_hhhhhhhhhh', '100.00'), received('o_hhhhhhhhhh', 'i_hhhhhhhhhh', '60.00')])
    const id = (await exceptionsOf(db, 'amount_mismatch'))[0].id
    expect(await judgeWithModel(ctx, id, 0)).toBe('retry')
    expect(await judgeWithModel(ctx, id, 1)).toBe('done')
    const ex = (await exceptionsOf(db, 'amount_mismatch'))[0]
    expect(ex).toMatchObject({ status: 'awaiting_human', copilot_state: 'model_error' })
    expect(ex.last_error.reason).toMatch(/action_not_allowed:refund_everything/)
    expect(await verdictsOf(db, id)).toHaveLength(0)
  })

  it('sem modelo configurado: resíduo vai direto para o humano com o motivo (nunca silencioso)', async () => {
    const { ctx, db } = await env()
    await load(ctx, [order('o_iiiiiiiiii', '100.00'), charge('o_iiiiiiiiii', 'i_iiiiiiiiii', '100.00'), received('o_iiiiiiiiii', 'i_iiiiiiiiii', '100.00', 5), received('o_iiiiiiiiii', 'i_ibaaaaaaaa', '100.00', 9)])
    const ex = (await exceptionsOf(db, 'duplicate_payment'))[0]
    expect(ex).toMatchObject({ status: 'awaiting_human', copilot_state: 'model_off', severity: 'high' })
    expect(ex.last_error.reason).toContain('COPILOT_MODE=off')
    expect((await db.query(`SELECT status FROM orders`)).rows[0].status).toBe('settling') // o primeiro pagamento segue; o segundo é a exceção
  })

  it('devolução pedida e concluída pela loja: caso confirmado, recibo refund_notice, exceção encerrada pelo sistema', async () => {
    const { ctx, db, chain } = await env()
    await load(ctx, [order('o_jjjjjjjjjj', '80.00'), charge('o_jjjjjjjjjj', 'i_jjjjjjjjjj', '80.00'), received('o_jjjjjjjjjj', 'i_jjjjjjjjjj', '80.00')])
    await settleAll(ctx, chain)
    await load(ctx, [{ ev: 'order.refund.requested', ts: at(120), store: 'equilibrium', ord: 'o_jjjjjjjjjj', amt: '80.00', cur: 'BRL', how: 'pix' }], 'b2')
    let ex = (await exceptionsOf(db, 'refund_requested'))[0]
    expect(ex).toMatchObject({ status: 'awaiting_human', copilot_state: 'model_off' })
    expect((await db.query(`SELECT refund_type, state FROM refund_cases`)).rows).toEqual([{ refund_type: 'merchant_refund', state: 'requested' }])
    await drain(ctx) // request_refund: atestado -> não chama provedor
    expect((await db.query(`SELECT state FROM refund_cases`)).rows[0].state).toBe('requested')
    await load(ctx, [{ ev: 'order.refund.completed', ts: at(200), store: 'equilibrium', ord: 'o_jjjjjjjjjj', amt: '80.00', cur: 'BRL', how: 'pix' }], 'b3')
    await settleAll(ctx, chain)
    expect((await db.query(`SELECT state FROM refund_cases`)).rows[0].state).toBe('confirmed')
    expect((await db.query(`SELECT receipt_type FROM receipts ORDER BY created_at`)).rows.map((r: any) => r.receipt_type)).toEqual(['settlement', 'refund_notice'])
    ex = (await exceptionsOf(db, 'refund_requested'))[0]
    expect(ex.status).toBe('resolved'); expect(ex.resolution).toMatchObject({ action: 'approve_refund', by: 'system' })
  })

  it('MED atestado: caso med_attested aberto (real, não simulado), exceção alta; handled encerra', async () => {
    const { ctx, db, chain } = await env()
    await load(ctx, [order('o_kkkkkkkkkk', '185.00'), charge('o_kkkkkkkkkk', 'i_kkkkkkkkkk', '185.00'), received('o_kkkkkkkkkk', 'i_kkkkkkkkkk', '185.00')])
    await settleAll(ctx, chain)
    await load(ctx, [{ ev: 'med.reported', ts: at(60 * 24 * 10), store: 'equilibrium', ord: 'o_kkkkkkkkkk', chg: 'i_kkkkkkkkkk', amt: '185.00', cur: 'BRL', st: 'open' }], 'b2')
    const ex = (await exceptionsOf(db, 'med_reported'))[0]
    expect(ex).toMatchObject({ status: 'awaiting_human', severity: 'high' })
    expect(ex.facts.med.days_since_payment).toBe(10)
    expect((await db.query(`SELECT refund_type, state, simulation_reason FROM refund_cases`)).rows).toEqual([{ refund_type: 'med_attested', state: 'requested', simulation_reason: null }])
    await load(ctx, [{ ev: 'med.handled', ts: at(60 * 24 * 12), store: 'equilibrium', ord: 'o_kkkkkkkkkk', amt: '185.00', cur: 'BRL' }], 'b3')
    expect((await exceptionsOf(db, 'med_reported'))[0].status).toBe('resolved')
  })

  it('pagamento depois do prazo: late_paid, caso late_payment_refund e exceção late_payment para o humano', async () => {
    const { ctx, db } = await env()
    await load(ctx, [order('o_llllllllll', '40.00'), charge('o_llllllllll', 'i_llllllllll', '40.00', 1), { ...received('o_llllllllll', 'i_llllllllll', '40.00', 90), late: 1 }])
    expect((await db.query(`SELECT status FROM orders`)).rows[0].status).toBe('late_paid')
    const ex = (await exceptionsOf(db, 'late_payment'))[0]
    expect(ex).toMatchObject({ status: 'awaiting_human' }); expect(ex.facts.context.late_minutes).toBe(29)
    await drain(ctx)
    expect((await db.query(`SELECT refund_type, state FROM refund_cases`)).rows).toEqual([{ refund_type: 'late_payment_refund', state: 'requested' }])
  })

  it('cobrança sem vencimento + operador atesta no prazo (late=0): pagamento horas depois NÃO é atrasado', async () => {
    const { ctx, db } = await env()
    const c = { ...charge('o_ssssssssss', 'i_ssssssssss', '40.00', 1) } as any; delete c.exp
    await load(ctx, [order('o_ssssssssss', '40.00'), c, received('o_ssssssssss', 'i_ssssssssss', '40.00', 60 * 20)])
    expect((await db.query(`SELECT status FROM orders`)).rows[0].status).toBe('settling')
    expect(await exceptionsOf(db, 'late_payment')).toHaveLength(0)
  })

  it('saque estornado: close_reversed pelas regras; saque falho vai ao humano; eventos de carteira só contam', async () => {
    const { ctx, db } = await env()
    const r = await load(ctx, [
      { ev: 'wallet.move.withdrawal_reversal', ts: at(1), store: 'mestre', dir: 'credit', amt: '120.00', cur: 'BRL', ord: null, wd: 'w_aaaaaaaaaa' },
      { ev: 'wallet.withdrawal.failed', ts: at(2), store: 'loja-2', wd: 'w_bbbbbbbbbb', src: 'partner', prov: 'eulen', amt: '300.00', fee: '3.00', cur: 'BRL', req: at(0) },
      { ev: 'wallet.withdrawal.sent', ts: at(3), store: 'loja-2', wd: 'w_cccccccccc', src: 'partner', prov: 'eulen', amt: '50.00', fee: '0.50', cur: 'BRL', req: at(0) },
      { ev: 'order.return.detected', ts: at(4), store: 'loja-2', ord: 'o_zzzzzzzzzz' },
    ])
    expect(r.proc).toMatchObject({ processed: 2, ignored: 2 })
    expect((await exceptionsOf(db, 'withdrawal_reversal'))[0].resolution.action).toBe('close_reversed')
    expect((await exceptionsOf(db, 'withdrawal_failed'))[0].status).toBe('awaiting_human')
    expect((await db.query(`SELECT code FROM pilot_stores ORDER BY code`)).rows.map((x: any) => x.code)).toEqual(['loja-2', 'mestre'])
  })

  it('decisão do operador: veredito operator, concordância medida, exceção encerrada; segunda decisão recusada', async () => {
    const { ctx, db } = await env()
    await load(ctx, [order('o_mmmmmmmmmm', '100.00'), charge('o_mmmmmmmmmm', 'i_mmmmmmmmmm', '100.00'), received('o_mmmmmmmmmm', 'i_mmmmmmmmmm', '60.00')])
    const id = (await exceptionsOf(db, 'amount_mismatch'))[0].id
    const d = await decideByOperator(ctx, id, 'refund_partial', 'payer confirmed on WhatsApp')
    expect(d).toEqual({ ok: true, agreed: null }) // sem veredito do copiloto (modelo off), não há com que concordar
    expect((await verdictsOf(db, id)).at(-1)).toMatchObject({ engine: 'operator', action: 'refund_partial' })
    expect((await exceptionsOf(db, 'amount_mismatch'))[0]).toMatchObject({ status: 'resolved' })
    expect(await decideByOperator(ctx, id, 'escalate', '')).toMatchObject({ ok: false, code: 'already_closed' })
    expect(await decideByOperator(ctx, id, 'close_benign_retry', '')).toMatchObject({ ok: false })
  })

  it('replay: resposta gravada ao vivo é reproduzida sem rede; entrada diferente = replay_miss com motivo', async () => {
    const live = new ScriptedModel('m-x', () => '{"action":"escalate","confidence":0.5,"requires_human":true,"rationale":"Not enough context to decide; needs the operator.","evidence_refs":["e1"]}')
    const { ctx, db } = await env()
    ctx.copilot = { model: new RecordingModel(live, db) }
    await load(ctx, [order('o_nnnnnnnnnn', '100.00'), charge('o_nnnnnnnnnn', 'i_nnnnnnnnnn', '100.00'), received('o_nnnnnnnnnn', 'i_nnnnnnnnnn', '60.00')])
    await drain(ctx)
    expect((await db.query(`SELECT count(*)::int AS n FROM copilot_replay`)).rows[0].n).toBe(1)
    ctx.copilot = { model: new ReplayModel(db, 'm-x') }
    await load(ctx, [order('o_oooooooooo', '100.00'), charge('o_oooooooooo', 'i_oooooooooo', '100.00'), received('o_oooooooooo', 'i_oooooooooo', '60.00')], 'b2')
    await drain(ctx)
    const ex = (await exceptionsOf(db, 'amount_mismatch'))
    expect(ex[0].copilot_state).toBe('model_done')
    // a segunda tem fatos diferentes (outro pedido), logo não há gravação: erro final com motivo, sem inventar
    expect(ex[1]).toMatchObject({ status: 'awaiting_human', copilot_state: 'model_error' })
    expect(ex[1].last_error.reason).toContain('replay_miss')
  })
})

describe('validação do veredito e política', () => {
  const ev = [{ id: 'e1', fact: 'a' }, { id: 'e2', fact: 'b' }]
  it('ação fora da lista, confiança fora de [0,1], referência desconhecida', () => {
    expect(validateVerdict('amount_mismatch', { action: 'close_benign_retry', confidence: 0.9, rationale: 'xxxxxxxxxx', evidence_refs: ['e1'] }, ev)).toMatchObject({ ok: false, reason: 'action_not_allowed:close_benign_retry' })
    expect(validateVerdict('amount_mismatch', { action: 'escalate', confidence: 1.2, rationale: 'xxxxxxxxxx', evidence_refs: ['e1'] }, ev)).toMatchObject({ ok: false, reason: 'confidence_out_of_range' })
    expect(validateVerdict('amount_mismatch', { action: 'escalate', confidence: 0.2, rationale: 'xxxxxxxxxx', evidence_refs: ['e9'] }, ev)).toMatchObject({ ok: false, reason: 'evidence_ref_unknown:e9' })
    const ok = validateVerdict('amount_mismatch', { action: 'refund_partial', confidence: '0.95', requires_human: false, rationale: 'the model says so, confidently', evidence_refs: ['e1', 'e1'] }, ev)
    expect(ok).toMatchObject({ ok: true, verdict: { action: 'refund_partial', confidence: 0.95, requires_human: true, evidence_refs: ['e1'] } }) // irreversível: humano sempre
  })
  it('política: só reversível com confiança e sem desacordo', () => {
    const v = (action: string, confidence: number, rh = false) => ({ action, confidence, requires_human: rh, rationale: 'r', evidence_refs: ['e1'] })
    expect(canAutoApply(v('hold_request_balance', 0.9))).toMatchObject({ ok: true })
    expect(canAutoApply(v('hold_request_balance', 0.8))).toMatchObject({ ok: false, reason: 'confidence_below_0.85' })
    expect(canAutoApply(v('refund_partial', 0.99))).toMatchObject({ ok: false, reason: 'irreversible_action' })
    expect(canAutoApply(v('hold_request_balance', 0.9), v('escalate', 0.9))).toMatchObject({ ok: false, reason: 'disagreement:escalate' })
  })
})

describe('rotas do piloto', () => {
  it('ingestão exige assinatura do corpo bruto; resumo e lista são públicos e sem dado pessoal; decisão exige token', async () => {
    const { ctx, db } = await env()
    const app = buildApp(ctx, { asaasWebhookToken: 'wh', diagnosticsToken: 'diag' })
    registerPilot(app, ctx, { hmacSecret: 'segredo', operatorToken: 'op-token', sourceId: 'odin' })
    const body = JSON.stringify({ source: 'odin', batch_id: 'hist-1', events: [order('o_pppppppppp', '100.00'), charge('o_pppppppppp', 'i_pppppppppp', '100.00'), received('o_pppppppppp', 'i_pppppppppp', '70.00')] })
    const bad = await app.inject({ method: 'POST', url: '/pilot/v1/events', headers: { 'content-type': BATCH_CONTENT_TYPE, 'x-pilot-signature': 'sha256=00' }, payload: body })
    expect(bad.statusCode).toBe(401); expect(bad.json().error.message).toContain('signature_mismatch')
    const ok = await app.inject({ method: 'POST', url: '/pilot/v1/events', headers: { 'content-type': BATCH_CONTENT_TYPE, 'x-pilot-signature': signBody('segredo', body) }, payload: body })
    expect(ok.statusCode).toBe(200); expect(ok.json()).toMatchObject({ accepted: 3, duplicates: 0, processed: { processed: 3 } })
    const wrongType = await app.inject({ method: 'POST', url: '/pilot/v1/events', headers: { 'content-type': 'application/json', 'x-pilot-signature': signBody('segredo', body) }, payload: body })
    expect(wrongType.statusCode).toBe(415)
    const s = (await app.inject({ method: 'GET', url: '/pilot/api/summary' })).json()
    expect(s.events).toMatchObject({ total: 3, processed: 3 }); expect(s.orders).toMatchObject({ orders: 1, paid: 0, on_hold: 1 })
    expect(s.stores[0]).toMatchObject({ code: 'equilibrium', orders: 1, exceptions: 1 })
    expect(s.copilot_model).toMatchObject({ mode: 'off' })
    const list = (await app.inject({ method: 'GET', url: '/pilot/api/exceptions?status=awaiting_human' })).json()
    expect(list.exceptions).toHaveLength(1)
    expect(JSON.stringify(list)).not.toMatch(/merchant_id|fingerprint|api_key/)
    const id = list.exceptions[0].id
    const det = (await app.inject({ method: 'GET', url: `/pilot/api/exceptions/${id}` })).json()
    expect(det.allowed_actions.map((a: any) => a.action)).toContain('refund_partial'); expect(det.timeline.length).toBeGreaterThan(0)
    const noTok = await app.inject({ method: 'POST', url: `/pilot/api/exceptions/${id}/decide`, payload: { action: 'refund_partial' } })
    expect(noTok.statusCode).toBe(401)
    const dec = await app.inject({ method: 'POST', url: `/pilot/api/exceptions/${id}/decide`, headers: { authorization: 'Bearer op-token' }, payload: { action: 'refund_partial', note: 'ok' } })
    expect(dec.statusCode).toBe(200)
    expect((await summary(ctx)).exceptions).toMatchObject({ decided_by_operator: 1 })
    // linha com dado pessoal no lote: recusada com o motivo, as outras entram
    const body2 = JSON.stringify({ source: 'odin', batch_id: 'hist-2', events: [{ ...order('o_qqqqqqqqqq', '10.00'), payer: 'Fulano' }, order('o_rrrrrrrrrr', '10.00')] })
    const r2 = (await app.inject({ method: 'POST', url: '/pilot/v1/events', headers: { 'content-type': BATCH_CONTENT_TYPE, 'x-pilot-signature': signBody('segredo', body2) }, payload: body2 })).json()
    expect(r2).toMatchObject({ accepted: 1, rejected: [{ index: 0, reason: 'forbidden_key:payer' }] })
    expect((await db.query(`SELECT count(*)::int AS n FROM attested_events`)).rows[0].n).toBe(4)
    await app.close()
  })
})
