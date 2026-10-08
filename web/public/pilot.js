// Painel do piloto: resumo ao vivo, fila de exceções com veredito e decisão do operador (com token).
import { $, h, brl, toast } from '/assets/common.js'

const KIND_LABEL = {
  duplicate_charge: 'Repeated charge', duplicate_payment: 'Paid twice', amount_mismatch: 'Amount mismatch', late_payment: 'Paid late',
  expired_unpaid: 'Expired unpaid', charge_failed: 'Charge failed', refund_requested: 'Refund requested', med_reported: 'MED dispute',
  manual_divergent: 'Manual Pix divergent', withdrawal_failed: 'Withdrawal failed', withdrawal_reversal: 'Withdrawal reversed',
}
const ENGINE_LABEL = { rules: 'rules', model: 'model', replay: 'model (replay)', operator: 'operator' }
const ago = (iso) => { if (!iso) return 'never'; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago` }
const fmtTs = (iso) => iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '-'
let token = ''
let publicReadOnly = true
try { token = localStorage.getItem('pixsettle.pilot.operator') ?? '' } catch { token = '' }

async function getJson(path) {
  const r = await fetch(path, { headers: { accept: 'application/json' } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`)
  return j
}

function bar(label, n, total, cls = '') {
  const pct = total ? Math.round((n / total) * 100) : 0
  const fill = h('div', { class: `fill ${cls}` }); fill.style.width = `${pct}%` // CSSOM, permitido pela CSP (sem atributo style inline)
  return h('div', { class: 'bar' }, h('span', {}, label), h('div', { class: 'track' }, fill), h('span', { class: 'n' }, String(n)))
}

async function refreshSummary() {
  let s
  try { s = await getJson('/pilot/api/summary') } catch (e) { setLive('down', `offline: ${e.message}`); return }
  publicReadOnly = s.public_read_only !== false
  const last = s.events.last_received_at
  const staleMs = last ? Date.now() - new Date(last).getTime() : Infinity
  setLive(staleMs < 15 * 60_000 ? 'ok' : 'stale', `historical export imported ${ago(last)}`)
  $('#k-orders').textContent = s.orders.orders.toLocaleString('en-US')
  $('#k-paid').textContent = brl(s.orders.paid_minor)
  $('#k-exc').textContent = String(s.exceptions.exceptions)
  $('#k-auto').textContent = String(s.exceptions.auto_applied)
  $('#k-human').textContent = String(s.exceptions.awaiting_human)
  $('#k-receipts').textContent = String(s.orders.receipts)

  const mb = $('#model-badge')
  mb.textContent = s.copilot_model.name ? `${s.copilot_model.name} (${s.copilot_model.mode})` : 'model off'
  mb.className = 'badge ' + (s.copilot_model.name ? 'model' : 'muted')
  const ex = s.exceptions
  const bars = $('#copilot-bars'); bars.replaceChildren(
    bar('Closed by rules', ex.by_rules, ex.exceptions, 'ok'),
    bar('Judged by model', ex.by_model, ex.exceptions, 'sim'),
    bar('Waiting for model', ex.model_pending + ex.model_jobs_pending, ex.exceptions, 'warn'),
    bar('Model unavailable', ex.model_off + ex.model_error, ex.exceptions, 'bad'),
    bar('Decided by operator', ex.decided_by_operator, ex.exceptions, 'ok'),
  )
  const agree = ex.operator_agreed + ex.operator_disagreed
  $('#copilot-note').textContent = s.copilot_model.name
    ? `Operator agreed with the copilot in ${ex.operator_agreed} of ${agree} decided cases.`
    : `No model configured (${s.copilot_model.reason}); the residue the rules cannot decide waits for a human with the reason shown.`
  $('#copilot-facts').replaceChildren(
    ...kv('Rule: money never moves on the copilot\'s word', 'refunds, credits and releases are proposals; a human confirms'),
    ...kv('Auto-apply', 'reversible actions only, confidence >= 0.85, rules and model in agreement'),
    ...kv('Verdicts', s.verdicts.map(v => `${ENGINE_LABEL[v.engine] ?? v.engine} ${v.n}`).join(', ') || 'none yet'),
    ...kv('Testnet settlement', s.pilot_settle ? 'on: each real paid order settles on Tempo testnet with a receipt' : 'off: reconciliation only (PILOT_SETTLE=0)'),
  )
  const tb = $('#stores tbody'); tb.replaceChildren(...s.stores.map(st => h('tr', {}, h('td', {}, st.code, st.store_type === 'partner' ? h('span', { class: 'muted small' }, ' partner') : null), h('td', { class: 'n' }, String(st.orders)), h('td', { class: 'n' }, String(st.paid)), h('td', { class: 'n' }, String(st.exceptions)))))
  const byKind = {}
  for (const r of ex.by_kind_status) byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n
  const kb = $('#kind-bars'); kb.replaceChildren(...Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => bar(KIND_LABEL[k] ?? k, n, ex.exceptions)))
  const fk = $('#f-kind'); if (fk.options.length <= 1) for (const k of Object.keys(KIND_LABEL)) fk.append(h('option', { value: k }, KIND_LABEL[k]))
  const fs = $('#f-store'); if (fs.options.length <= 1) for (const st of s.stores) fs.append(h('option', { value: st.code }, st.code))
  $('#stream').replaceChildren(
    ...kv('Events received', `${s.events.total.toLocaleString('en-US')} (${s.events.processed} applied, ${s.events.ignored} statistical, ${s.events.unmapped} unmapped, ${s.events.errors} errors)`),
    ...kv('Period', `${fmtTs(s.events.first_ts)} to ${fmtTs(s.events.last_ts)}`),
    ...kv('Last event', s.last_event ? `${s.last_event.ev} at ${fmtTs(s.last_event.ts)} (${s.last_event.store_code}), received ${ago(s.last_event.received_at)}` : 'none'),
    ...kv('On hold', `${s.orders.on_hold} orders (amount mismatch and similar), ${s.orders.settlements_confirmed} testnet settlements confirmed`),
  )
}
const kv = (k, v) => [h('dt', {}, k), h('dd', {}, v)]

function setLive(state, text) {
  const b = $('#live'); b.className = `badge live ${state === 'ok' ? '' : state}`; $('#live-text').textContent = text
}

async function refreshQueue() {
  const q = new URLSearchParams()
  for (const [id, k] of [['#f-status', 'status'], ['#f-kind', 'kind'], ['#f-store', 'store']]) { const v = $(id).value; if (v) q.set(k, v) }
  q.set('limit', '100')
  let r
  try { r = await getJson(`/pilot/api/exceptions?${q}`) } catch (e) { $('#queue').replaceChildren(h('li', { class: 'muted' }, `Could not load: ${e.message}`)); return }
  const ul = $('#queue')
  if (!r.exceptions.length) { ul.replaceChildren(h('li', { class: 'muted' }, 'Nothing in this filter.')); return }
  ul.replaceChildren(...r.exceptions.map(card))
}

function card(e) {
  const v = e.verdict
  return h('li', { class: 'exc', onclick: () => openDetail(e.id) },
    h('div', { class: 'head' },
      h('span', { class: `sev ${e.severity}`, title: e.severity }),
      h('span', { class: 'badge kind' }, KIND_LABEL[e.kind] ?? e.kind),
      h('span', { class: `badge st-${e.status}` }, e.status.replace('_', ' ')),
      e.store ? h('span', { class: 'muted small' }, e.store) : null,
      h('span', { class: 'muted small push' }, ago(e.detected_at)),
    ),
    h('div', { class: 'sum' }, e.summary),
    h('div', { class: 'meta' }, e.ord ? `order ${e.ord} (${e.order_status}${e.order_amount_minor ? `, ${brl(e.order_amount_minor)}` : ''})` : 'no order (wallet event)'),
    v ? verdictBox(v) : h('div', { class: 'verdict muted' }, e.copilot_state === 'model_off' ? `No verdict: ${e.last_error?.reason ?? 'model off'}. ${e.last_error?.why ?? ''}` : e.copilot_state === 'model_error' ? `Model failed: ${e.last_error?.reason ?? '?'}` : e.copilot_state === 'pending_model' ? 'Waiting for the model' : 'No verdict yet'),
  )
}

function verdictBox(v) {
  const pct = Math.round(Number(v.confidence) * 100)
  const meter = h('i'); meter.style.width = `${pct}%`
  return h('div', { class: 'verdict' },
    h('div', {}, h('span', { class: `badge ${v.engine}` }, ENGINE_LABEL[v.engine] ?? v.engine), ' ', h('span', { class: 'act' }, v.action_label ?? v.action),
      v.engine !== 'operator' ? h('span', { class: 'muted small' }, ` confidence ${pct}%`, h('span', { class: 'conf' }, meter)) : null,
      v.requires_human ? h('span', { class: 'badge st-awaiting_human ml6' }, 'needs human') : null),
    h('div', { class: 'muted mt4' }, v.rationale),
    h('div', { class: 'muted small' }, `evidence ${(v.evidence_refs ?? []).join(', ')}`),
  )
}

async function openDetail(id) {
  let d
  try { d = await getJson(`/pilot/api/exceptions/${id}`) } catch (e) { toast(e.message); return }
  const card = $('#drawer-card')
  const close = () => $('#drawer').classList.add('hidden')
  card.replaceChildren(...[
    h('div', { class: 'row mb12' }, h('h3', {}, KIND_LABEL[d.kind] ?? d.kind), h('span', { class: `badge st-${d.status}` }, d.status.replace('_', ' ')), h('button', { class: 'ghost close', onclick: close }, 'Close')),
    h('p', { class: 'm0' }, d.summary),
    h('p', { class: 'muted small' }, d.ord ? `store ${d.store}, order ${d.ord}: ${d.order_status}${d.hold_reason ? `, on hold (${d.hold_reason})` : ''}, ${d.order_amount_minor ? brl(d.order_amount_minor) : ''}${d.paid_at ? `, paid ${fmtTs(d.paid_at)}` : ''}` : `store ${d.store}`),
    h('h2', {}, 'Evidence'),
    h('ul', { class: 'evid' }, ...(d.evidence ?? []).map(e => h('li', {}, h('span', { class: 'id' }, e.id), h('span', {}, e.fact)))),
    h('h2', {}, 'Verdicts'),
    ...(d.verdicts.length ? d.verdicts.map(v => h('div', {}, verdictBox(v), h('div', { class: 'hash' }, `${fmtTs(v.created_at)} · input ${v.input_hash.slice(0, 16)} · verdict ${v.verdict_hash.slice(0, 16)}${v.latency_ms != null ? ` · ${v.latency_ms} ms` : ''}`))) : [h('p', { class: 'muted small' }, 'No verdict recorded.')]),
    publicReadOnly ? h('p', { class: 'muted small' }, 'Public replay is read-only. Operator decisions are recorded in the private shadow workspace.') : d.status === 'awaiting_human' || d.status === 'open' || d.status === 'auto_applied' ? decideBox(d, close) : null,
    h('h2', {}, 'Timeline'),
    h('ol', { class: 'timeline-pilot' }, ...d.timeline.map(t => h('li', {}, h('span', { class: 't' }, fmtTs(t.created_at)), `${t.from_state ?? '·'} → ${t.to_state}`, t.reason ? h('span', { class: 'muted' }, `: ${t.reason}`) : null))),
    d.receipts?.length ? h('p', { class: 'small' }, 'Receipts: ', ...d.receipts.map(r => h('a', { href: `/receipt/${r.id}`, target: '_blank' }, `${r.receipt_type} `))) : null,
  ].filter(Boolean))
  $('#drawer').classList.remove('hidden')
}

function decideBox(d, close) {
  const note = h('input', { placeholder: 'note for the audit trail (optional)', maxlength: '500' })
  const buttons = d.allowed_actions.map(a => h('button', { class: 'ghost', onclick: () => decide(d.id, a.action, note.value, close) }, a.label))
  buttons.push(h('button', { class: 'ghost', onclick: () => decide(d.id, 'dismiss', note.value, close) }, 'Dismiss'))
  return h('div', {}, h('h2', {}, 'Operator decision'),
    token ? null : h('p', { class: 'muted small' }, 'Deciding needs the operator token (kept only in this browser).'),
    h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: setToken }, token ? 'Change operator token' : 'Enter operator token')),
    note, h('div', { class: 'decide' }, ...buttons))
}
function setToken() {
  const t = prompt('Operator token')
  if (t == null) return
  token = t.trim()
  try { localStorage.setItem('pixsettle.pilot.operator', token) } catch { /* sem armazenamento: fica só na memória */ }
  toast(token ? 'Token saved in this browser' : 'Token cleared')
}
async function decide(id, action, note, close) {
  if (!token) { setToken(); if (!token) return }
  const r = await fetch(`/pilot/api/exceptions/${id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action, note }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) { toast(j?.error?.message ?? `HTTP ${r.status}`); return }
  toast(j.agreed_with_copilot === true ? 'Recorded: agrees with the copilot' : j.agreed_with_copilot === false ? 'Recorded: overrides the copilot' : 'Recorded')
  close(); refreshQueue(); refreshSummary()
}

for (const id of ['#f-status', '#f-kind', '#f-store']) $(id).addEventListener('change', refreshQueue)
$('#drawer').addEventListener('click', e => { if (e.target === $('#drawer')) $('#drawer').classList.add('hidden') })
refreshSummary(); refreshQueue()
setInterval(refreshSummary, 15_000); setInterval(refreshQueue, 20_000)
