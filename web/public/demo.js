import { $, h, brl, units, short, api, toast } from './common.js'

let current = null, poll = null, lastCount = 0

// Rótulos em inglês para cada transição gravada no core.
const LABELS = {
  'order:created': 'Order created',
  'charge_creation:creating': 'Requesting Pix charge from provider',
  'charge_creation:created': 'Pix charge ready (QR issued)',
  'charge_creation:creation_unknown': 'Provider did not answer, reconciling by reference',
  'charge_creation:creation_failed': 'Pix charge creation failed',
  'order:awaiting_payment': 'Waiting for the payer',
  'charge_observed:received': 'Provider confirms Pix received',
  'charge_observed:confirmed': 'Provider confirms payment',
  'charge_observed:partially_refunded': 'Provider shows a partial refund',
  'charge_observed:refunded': 'Provider shows the payment fully refunded',
  'order:paid': 'Order paid',
  'settlement:intent_recorded': 'Settlement intent recorded (immutable)',
  'order:settling': 'Settling',
  'attempt:nonce_reserved': 'Nonce reserved for the treasury',
  'settlement:in_progress': 'Settlement in progress',
  'attempt:signed': 'Transfer signed offline (hash stored before sending)',
  'attempt:broadcast_pending': 'Broadcasting to Tempo',
  'attempt:broadcast_sent': 'Accepted by the Tempo node',
  'attempt:confirmed': 'Confirmed on-chain, identity checked',
  'settlement:confirmed': 'Settlement confirmed',
  'order:settled': 'Order settled',
  'attempt:suspended': 'Attempt suspended before broadcast',
  'attempt:unknown': 'Broadcast outcome unknown, reconciling',
  'attempt:manual_review': 'Sent to manual review',
  'order:late_paid': 'Paid after the deadline',
  'refund_case:requested': 'Refund case opened',
  'refund_case:confirmed': 'Refund confirmed by the Pix provider',
  'refund_case:unknown': 'Refund outcome unknown, reconciling',
  'refund_case:failed': 'Refund rejected by the provider',
  'refund_accounting:recorded': 'Reserve accounting updated (simulated)',
  'settlement:failed': 'Settlement cancelled',
  'order:refunded': 'Order refunded',
}
const REFUND_TYPE = { merchant_refund: 'Merchant refund', med_simulated: 'MED claim (simulated)', provider_refund: 'Refund made at the provider', late_payment_refund: 'Late payment refund' }
const WARN = /hold|suspended|unknown|manual_review|late_paid|refund|blocked|failed|conflict|review|MED/

function label(t) {
  if (t.entity === 'order_hold') return `On hold: ${t.to_state.replaceAll('_', ' ')}`
  if (t.entity === 'settlement_blocked') return 'Settlement blocked'
  if (t.entity === 'refund_blocked') return `Refund refused: ${t.to_state.replaceAll('_', ' ')}`
  return LABELS[`${t.entity}:${t.to_state}`] ?? `${t.entity}: ${t.to_state}`
}
function detail(t) {
  if (t.entity === 'settlement' && t.to_state === 'intent_recorded' && t.reason) {
    try { const a = JSON.parse(t.reason); return `gross ${units(a.gross)}, reserve ${units(a.reserve_simulated)}, net ${units(a.net)} pathUSD` } catch { }
  }
  if (t.entity === 'charge_creation' && t.to_state === 'creation_failed') return t.reason ?? ''
  if (t.entity === 'order_hold') {
    const m = /pago (\d+), cobrado (\d+)/.exec(t.reason ?? '')
    return m ? `paid ${brl(m[1])}, charged ${brl(m[2])}; nothing is sent on-chain` : 'nothing is sent on-chain until reviewed'
  }
  if (t.entity === 'refund_accounting') {
    try { const a = JSON.parse(t.reason); return `exposure ${units(a.exposure)}, reserve covered ${units(a.reserve_consumed_simulated)}, merchant debt ${units(a.debt_simulated)} pathUSD` } catch { }
  }
  if (t.entity === 'refund_case' && t.to_state === 'requested') return (t.reason ?? '').startsWith('SIMULADO') ? 'MED claim, simulated' : (REFUND_TYPE[t.reason] ?? '')
  if (t.entity === 'settlement_blocked') return 'an open refund case blocks signing'
  if (t.entity === 'attempt' && t.to_state === 'nonce_reserved') return (t.reason ?? '').replace('pendente na cadeia', 'chain pending').replace('maior reservado', 'max reserved')
  return t.source?.startsWith('event:') ? `from webhook ${t.source.slice(6)}` : ''
}

function parseAmount(v) {
  const m = String(v).trim().replace(/\./g, '').replace(',', '.').match(/^\d+(\.\d{1,2})?$/)
  return m ? Math.round(Number(m[0]) * 100) : null
}

function setStatus(o) {
  const s = $('#status')
  const map = { awaiting_payment: ['warn', 'Awaiting payment'], paid: ['warn', 'Paid'], settling: ['warn', 'Settling'], settled: ['ok', 'Settled'], created: ['muted', 'Created'], expired: ['bad', 'Expired'], late_paid: ['bad', 'Late payment'], refunded: ['muted', 'Refunded'] }
  const [k, t] = o.hold_reason ? ['bad', 'On hold'] : map[o.status] ?? ['muted', o.status]
  s.className = `badge ${k}`
  s.replaceChildren(...(k === 'warn' ? [h('span', { class: 'pulse' })] : []), t)
}

function render(o) {
  setStatus(o)
  $('#k-brl').textContent = brl(o.amount_minor)
  $('#k-net').textContent = o.hold_reason ? '0.00' : units(o.amounts.net)
  $('#k-res').textContent = o.hold_reason ? '0.00' : units(o.amounts.reserve_simulated)
  $('#l-net').textContent = o.status === 'settled' ? 'Merchant got (pathUSD)' : o.hold_reason ? 'Held, not sent' : 'Merchant will get (pathUSD)'
  const tl = o.timeline
  const at = (e, s) => tl.find(t => t.entity === e && t.to_state === s)
  const paid = at('order', 'paid'), settled = at('order', 'settled')
  $('#k-time').textContent = paid && settled ? `${((new Date(settled.created_at) - new Date(paid.created_at)) / 1000).toFixed(1)} s` : paid ? '...' : '-'

  const facts = [
    ['Order', h('span', { class: 'mono' }, o.id)],
    ['Quote', `${o.amounts.rate_num}/${o.amounts.rate_den} units per centavo (simulated)`],
    ['Reserve', `${o.amounts.reserve_bps / 100}% held back (simulated accounting)`],
  ]
  if (o.webhooks.deliveries) facts.push(['Webhooks', `${o.webhooks.deliveries} deliveries, ${o.webhooks.events} processed, ${o.webhooks.duplicates_ignored} duplicates ignored`])
  if (o.settlement) facts.push(['Memo', h('span', { class: 'mono' }, o.settlement.id)])
  if (o.chain?.recipient) facts.push(['Merchant wallet', h('span', { class: 'mono' }, o.chain.recipient)])
  if (o.chain?.nonce) facts.push(['Treasury nonce', o.chain.nonce])
  if (o.settlement?.tx_hash) facts.push(['Transaction', h('span', { class: 'mono' }, short(o.settlement.tx_hash, 10))])
  if (o.chain?.block_number) facts.push(['Block', o.chain.block_number])
  $('#facts').replaceChildren(...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))

  const links = []
  if (o.chain?.explorer_url) links.push(h('a', { href: o.chain.explorer_url, target: '_blank', rel: 'noopener' }, h('button', { class: 'ghost' }, 'View on Tempo explorer')))
  if (o.receipt_id) links.push(h('a', { href: `/receipt/${o.receipt_id}`, target: '_blank', rel: 'noopener' }, h('button', {}, 'Open verifiable receipt')))
  $('#links').replaceChildren(...links)

  if (tl.length !== lastCount) {
    const t0 = new Date(tl[0]?.created_at ?? Date.now())
    $('#timeline').replaceChildren(...tl.map((t, i) => {
      const warn = WARN.test(t.entity + ':' + t.to_state)
      const li = h('li', { class: warn ? 'warn' : 'ok' }, h('span', { class: 'dot' }),
        h('div', { class: 't' }, label(t)),
        h('div', { class: 'd' }, `+${((new Date(t.created_at) - t0) / 1000).toFixed(2)} s`, detail(t) ? ` · ${detail(t)}` : ''))
      if (i < lastCount) li.style.animation = 'none'
      return li
    }))
    lastCount = tl.length
  }
  renderRefunds(o)
  const open = o.refunds.some(r => ['requested', 'unknown'].includes(r.state))
  const refunded = o.refunds.filter(r => r.state !== 'failed').reduce((a, r) => a + Number(r.amount_minor), 0)
  const done = o.status === 'settled' && o.receipt_id && !open && o.refunds.every(r => r.state !== 'confirmed' || o.receipts.some(x => x.refund_case_id === r.id))
  $('#pay').disabled = $('#under').disabled = !(o.status === 'awaiting_payment' && !o.hold_reason)
  const canRefund = o.status === 'settled' && !open && !o.hold_reason && refunded < Number(o.amount_minor)
  $('#refund').disabled = !canRefund || Number(o.amount_minor) - refunded < 1000
  $('#med').disabled = !canRefund
  return done || !!o.hold_reason
}

function renderRefunds(o) {
  const p = o.reserve_pool
  $('#r-held').textContent = units(p.held); $('#r-used').textContent = units(p.consumed)
  $('#r-bal').textContent = units(p.balance); $('#r-debt').textContent = units(p.debt)
  if (!o.refunds.length) { $('#refunds').replaceChildren(h('li', { class: 'muted' }, 'No refunds for this order.')); return }
  $('#refunds').replaceChildren(...o.refunds.map(r => {
    const rc = o.receipts.find(x => x.refund_case_id === r.id)
    const state = { confirmed: 'ok', failed: 'bad', unknown: 'warn', requested: 'warn' }[r.state] ?? 'muted'
    return h('li', {},
      h('span', {}, `${REFUND_TYPE[r.refund_type] ?? r.refund_type}: ${brl(r.amount_minor)}`),
      h('span', { class: 'row' }, rc ? h('a', { href: `/receipt/${rc.id}`, target: '_blank', rel: 'noopener', class: 'small' }, 'notice') : null, h('span', { class: `badge ${state}` }, r.state)))
  }))
}

async function refresh() {
  if (!current) return
  try {
    const o = await api(`/demo/api/orders/${current.id}`)
    const finished = render(o)
    if (finished) { clearInterval(poll); poll = null; loadRecent() }
  } catch (e) { toast(e.message) }
}
function watch() { clearInterval(poll); poll = setInterval(refresh, 500); refresh() }

async function open(id, token) {
  current = { id, token }; lastCount = 0
  $('#timeline').replaceChildren()
  $('#phone').replaceChildren(token
    ? h('iframe', { src: `/pay/${token}`, title: 'Payer checkout' })
    : h('div', { class: 'empty' }, 'Checkout link is only shown right after creation.'))
  watch()
}

$('#create').onclick = async () => {
  const minor = parseAmount($('#amt').value)
  if (!minor) return toast('Type an amount like 100,90')
  const btn = $('#create'); btn.disabled = true
  try {
    const r = await api('/demo/api/orders', { method: 'POST', body: JSON.stringify({ amount_minor: minor, description: $('#desc').value }) })
    await open(r.order_id, r.checkout_token)
    loadRecent()
  } catch (e) { toast(e.message) } finally { btn.disabled = false }
}

async function simulate(scenario) {
  if (!current) return
  $('#pay').disabled = $('#under').disabled = true
  try {
    const r = await api(`/demo/api/orders/${current.id}/simulate`, { method: 'POST', body: JSON.stringify({ scenario, deliveries: 3 }) })
    const dup = r.deliveries.filter(d => d.duplicate).length
    toast(`Webhook sent ${r.deliveries.length} times, ${dup} flagged as duplicate`)
    if (!poll) watch()
  } catch (e) { toast(e.message) }
}
async function refundAction(path, body, msg) {
  if (!current) return
  $('#refund').disabled = $('#med').disabled = true
  try { await api(`/demo/api/orders/${current.id}/${path}`, { method: 'POST', body: JSON.stringify(body) }); toast(msg); if (!poll) watch() }
  catch (e) { toast(e.message); refresh() }
}
$('#refund').onclick = () => refundAction('refund', { amount_minor: 1000 }, 'Refund requested through the merchant API')
$('#med').onclick = () => refundAction('med', {}, 'MED claim opened (simulated)')
$('#pay').onclick = () => simulate('pay')
$('#under').onclick = () => simulate('underpay')

async function loadRecent() {
  try {
    const { orders } = await api('/demo/api/orders')
    if (!orders.length) return
    $('#recent').replaceChildren(...orders.map(o => h('li', { onclick: () => open(o.id, null), title: o.id },
      h('span', {}, brl(o.amount_minor)),
      h('span', { class: `badge ${o.hold_reason ? 'bad' : o.status === 'settled' ? 'ok' : 'muted'}` }, o.hold_reason ? 'on hold' : o.status.replaceAll('_', ' ')))))
  } catch { }
}
loadRecent()
