// Página pública (só leitura) de um beneficiário pseudonimizado: /pilot/affiliates/<ref>. Dados de /pilot/api/affiliates/<ref>.
import { $, h } from './common.js'

const ref = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '')
const setLive = (state, text) => { const b = $('#live'); b.className = `badge live ${state}`; $('#live-text').textContent = text }
const when = iso => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '-')
const statusLabel = {
  pending: 'waiting for release', released: 'released', settling: 'paying on Tempo', settled: 'paid on Tempo', voided: 'reversed', failed: 'failed',
  requested: 'requested', paid: 'paid by Pix',
}
const pill = s => h('span', { class: `pill ${s}` }, statusLabel[s] ?? s)

function explorerLink(tx) {
  if (!tx) return h('span', { class: 'muted' }, '-')
  return h('a', { href: `https://explore.testnet.tempo.xyz/tx/${tx}`, target: '_blank', rel: 'noopener' }, `${tx.slice(0, 10)}…`)
}

async function load() {
  if (!ref || ref === 'affiliates') { setLive('down', 'no beneficiary in the address'); return }
  let v
  try {
    const r = await fetch(`/pilot/api/affiliates/${encodeURIComponent(ref)}`, { headers: { accept: 'application/json' } })
    v = await r.json(); if (!r.ok) throw new Error(v?.error?.message ?? `HTTP ${r.status}`)
  } catch (e) { setLive('down', `offline: ${e.message}`); return }
  setLive('ok', v.rate_now?.brl_per_usd ? `rate R$ ${v.rate_now.brl_per_usd} per USD (${v.rate_now.source}, ${v.rate_now.age_s}s)` : `rate unavailable: ${v.rate_now?.unavailable ?? ''}`)
  $('#aff-ref').textContent = v.beneficiary_ref
  $('#aff-kind').textContent = v.kind === 'partner_percent' ? 'partner (percentage)' : 'affiliate'
  $('#aff-usd').textContent = `US$ ${v.balances.available.usd}`
  $('#aff-brl').textContent = v.balances.available.brl_now != null ? `≈ R$ ${v.balances.available.brl_now} today` : 'BRL value unavailable right now'
  $('#aff-token').textContent = `${v.currency.note} · chain ${v.currency.chain_id} · token ${v.currency.token.slice(0, 10)}… · ${v.payout.mode === 'own_wallet' ? 'paid to own wallet' : 'held in the merchant pool with a memo per commission'}`
  $('#k-pending').textContent = `US$ ${v.balances.pending.usd}`
  $('#k-available').textContent = `US$ ${v.balances.available.usd}`
  $('#k-withdrawn').textContent = `US$ ${v.balances.withdrawn.usd}`
  const tb = $('#commissions tbody'); tb.replaceChildren()
  for (const c of v.commissions) {
    const rate = (10_000 * Number(c.quote.rate_den) / Number(c.quote.rate_num)).toFixed(4) // unidades por centavo -> R$ por USD
    tb.append(h('tr', {},
      h('td', {}, h('div', {}, when(c.occurred_at)), h('div', { class: 'small muted' }, c.id.slice(0, 14) + '…')),
      h('td', {}, `R$ ${c.amount.brl}`),
      h('td', { class: 'strong' }, `US$ ${c.usd.usd}`),
      h('td', {}, h('div', {}, `R$ ${rate}`), h('div', { class: 'small muted' }, `${c.quote.source}${c.quote.fee_bps ? ` · fee ${c.quote.fee_bps / 100}%` : ''}`)),
      h('td', {}, pill(c.status), c.reason_code ? h('div', { class: 'small muted' }, c.reason_code) : null),
      h('td', {}, c.payout ? h('div', {}, explorerLink(c.payout.tx_hash), c.payout.receipt_id ? h('div', { class: 'small' }, h('a', { href: `/pilot/api/affiliates/receipts/${c.payout.receipt_id}` }, 'receipt')) : null, c.payout.hold_reason ? h('div', { class: 'small muted' }, c.payout.hold_reason) : null) : h('span', { class: 'muted' }, '-')),
    ))
  }
  if (!v.commissions.length) tb.append(h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No commissions yet.')))
  const wb = $('#withdrawals tbody'); wb.replaceChildren()
  for (const w of v.withdrawals) {
    wb.append(h('tr', {},
      h('td', {}, when(w.created_at)),
      h('td', {}, w.kind === 'pix' ? 'Pix' : 'own wallet'),
      h('td', {}, `US$ ${w.usd.usd}`),
      h('td', {}, w.kind === 'pix' ? h('div', {}, h('div', { class: 'strong' }, `R$ ${w.net.brl}`), h('div', { class: 'small muted' }, `fee R$ ${w.fee.brl}`)) : explorerLink(w.payout?.tx_hash)),
      h('td', {}, pill(w.status), w.reason_code ? h('div', { class: 'small muted' }, w.reason_code) : null),
    ))
  }
  $('#wd-empty').classList.toggle('hidden', v.withdrawals.length > 0)
}
load(); setInterval(load, 20_000)
