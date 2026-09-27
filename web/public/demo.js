import { $, h, brl, units, short, api, toast } from './common.js'

let current = null, poll = null, lastCount = 0

// Rótulos em inglês para cada transição gravada no core.
const LABELS = {
  'order:created': 'Order created',
  'charge_creation:creating': 'Requesting Pix charge from provider',
  'charge_creation:created': 'Pix charge ready (QR issued)',
  'charge_creation:creation_unknown': 'Provider did not answer, reconciling by reference',
  'order:awaiting_payment': 'Waiting for the payer',
  'charge_observed:received': 'Provider confirms Pix received',
  'charge_observed:confirmed': 'Provider confirms payment',
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
}
const WARN = /hold|suspended|unknown|manual_review|late_paid|refund|blocked|failed|conflict|review/

function label(t) {
  if (t.entity === 'order_hold') return `On hold: ${t.to_state.replaceAll('_', ' ')}`
  if (t.entity === 'settlement_blocked') return 'Settlement blocked'
  return LABELS[`${t.entity}:${t.to_state}`] ?? `${t.entity}: ${t.to_state}`
}
function detail(t) {
  if (t.entity === 'settlement' && t.to_state === 'intent_recorded' && t.reason) {
    try { const a = JSON.parse(t.reason); return `gross ${units(a.gross)}, reserve ${units(a.reserve_simulated)}, net ${units(a.net)} pathUSD` } catch { }
  }
  if (t.entity === 'order_hold') {
    const m = /pago (\d+), cobrado (\d+)/.exec(t.reason ?? '')
    return m ? `paid ${brl(m[1])}, charged ${brl(m[2])}; nothing is sent on-chain` : 'nothing is sent on-chain until reviewed'
  }
  if (t.entity === 'attempt' && t.to_state === 'nonce_reserved') return (t.reason ?? '').replace('pendente na cadeia', 'chain pending').replace('maior reservado', 'max reserved')
  return t.source?.startsWith('event:') ? `from webhook ${t.source.slice(6)}` : ''
}

function parseAmount(v) {
  const m = String(v).trim().replace(/\./g, '').replace(',', '.').match(/^\d+(\.\d{1,2})?$/)
  return m ? Math.round(Number(m[0]) * 100) : null
}

function setStatus(o) {
  const s = $('#status')
  const map = { awaiting_payment: ['warn', 'Awaiting payment'], paid: ['warn', 'Paid'], settling: ['warn', 'Settling'], settled: ['ok', 'Settled'], created: ['muted', 'Created'], expired: ['bad', 'Expired'], late_paid: ['bad', 'Late payment'] }
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
  const done = o.status === 'settled' && o.receipt_id
  $('#pay').disabled = $('#under').disabled = !(o.status === 'awaiting_payment' && !o.hold_reason)
  return done || !!o.hold_reason
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
