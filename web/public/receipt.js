import './verify.js'
import { $, h, brl, units, short, api, providerBadge } from './common.js'

const id = location.pathname.split('/').pop()
const ICON = { ok: '✓', fail: '✕', info: 'i', unavailable: '?' }

function hero(kind, title, text) {
  const el = $('#hero'); el.className = `hero ${kind}`
  el.replaceChildren(h('div', { class: 'big-ico' }, kind === 'ok' ? '✓' : kind === 'bad' ? '✕' : kind === 'warn' ? '!' : h('span', { class: 'spin' })), h('div', {}, h('h1', {}, title), h('p', {}, text)))
}

function memoText(memo) {
  try { const b = memo.slice(2).match(/../g).map(x => parseInt(x, 16)).filter(x => x); return String.fromCharCode(...b) } catch { return '' }
}

async function run() {
  let env, meta
  try { [env, meta] = await Promise.all([api(`/r/${encodeURIComponent(id)}`), api('/.well-known/pixsettle.json')]) }
  catch (e) { hero('bad', 'Receipt not found', e.message); return }
  const pinned = new URLSearchParams(location.search).get('issuer')
  const trusted = pinned ? [pinned] : meta.trusted_issuers.map(i => i.address)
  $('#issuer').textContent = trusted.join(', ') + (pinned ? ' (pinned by URL)' : ' (published by this server)')
  $('#dl').onclick = () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(env, null, 2)], { type: 'application/json' })), download: `${id}.json` })
    document.body.append(a); a.click(); a.remove()
  }
  $('#again').onclick = () => verify(env, trusted, meta)
  details(env.payload, meta)
  if (env.payload.receipt_type === 'refund_notice') $('#how').textContent = 'Your browser recomputed the SHA-256 digest of the canonical JSON (RFC 8785) and recovered the EIP-191 signer. A refund notice is a signed statement by the issuer about what the Pix provider reported; there is no on-chain transfer to check.'
  await verify(env, trusted, meta)
}

async function verify(env, trusted, meta) {
  hero('run', 'Verifying', 'Checking the signature and reading the transaction from Tempo.')
  $('#steps').replaceChildren(h('div', { class: 'step' }, h('span', { class: 'ico run' }, h('span', { class: 'spin' })), h('div', {}, 'Running checks...')))
  let steps
  try { steps = await globalThis.PixSettleVerify.verifyReceipt(env, trusted, meta.chain.rpc) }
  catch (e) {
    // Nunca deixar a tela presa em "Verifying": mostra o motivo e deixa tentar de novo.
    $('#steps').replaceChildren(h('div', { class: 'step' }, h('span', { class: 'ico unavailable' }, '?'), h('div', {}, h('div', { class: 'strong' }, 'Verification could not complete'), h('div', { class: 'small muted' }, String(e?.message ?? e)))))
    hero('warn', 'Verification could not complete', 'Nothing was concluded about this receipt. Use "Verify again" in a moment.')
    return
  }
  $('#steps').replaceChildren(...steps.map(s => h('div', { class: 'step' },
    h('span', { class: `ico ${s.state}` }, ICON[s.state]),
    h('div', {}, h('div', { class: 'strong' }, s.label), h('div', { class: 'small muted' }, s.detail)))))
  const fail = steps.some(s => s.state === 'fail'), unavailable = steps.some(s => s.state === 'unavailable')
  if (fail) hero('bad', 'Verification failed', 'Do not trust this receipt. See the failing check below.')
  else if (unavailable) {
    const reason = steps.find(s => s.state === 'unavailable')?.reason
    if (reason === 'receipt_not_found') hero('warn', 'Signature valid, transaction not found yet', 'The Tempo RPC answered but has no receipt for this transaction yet. It may still be pending, or the node may be behind. Use "Verify again" in a moment.')
    else if (reason === 'rpc_incomplete') hero('warn', 'Signature valid, chain answer incomplete', 'The Tempo RPC returned an incomplete receipt. Nothing was concluded. Use "Verify again" in a moment.')
    else hero('warn', 'Signature valid, chain check unavailable', 'The Tempo RPC could not be reached. Nothing was concluded. Use "Verify again" in a moment.')
  }
  else if (env.payload.receipt_type === 'refund_notice') hero('ok', 'Refund notice verified', 'Signed by a trusted issuer. The refund itself is attested by the issuer from the Pix provider, not proven on-chain.')
  else hero('ok', 'Receipt verified', 'Signed by a trusted issuer and matched to a successful transfer on Tempo.')
}

function refundDetails(p) {
  const r = p.refund, acc = p.accounting
  const TYPES = { merchant_refund: 'Merchant refund', med_simulated: 'MED claim (simulated)', provider_refund: 'Refund made at the provider', late_payment_refund: 'Late payment refund' }
  const rows = [
    ['Order', h('span', { class: 'mono' }, p.order.id)],
    ['Order amount', brl(p.order.amount.amount)],
    ['Refunded', h('b', {}, brl(r.amount.amount))],
    ['Type', TYPES[r.refund_type] ?? r.refund_type],
    ['State', `${r.state}, observed ${new Date(r.observed_at).toLocaleString()} at ${r.provider} (${p.provider_env})`],
  ]
  if (r.simulation_reason) rows.push(['Simulation', r.simulation_reason])
  if (acc) rows.push(['Reserve used', `${units(acc.reserve_consumed_simulated, acc.scale)} ${acc.currency} (simulated)`], ['Merchant debt', `${units(acc.debt_simulated, acc.scale)} ${acc.currency} (simulated)`])
  if (p.settlement_ref) rows.push(['Settlement receipt', h('a', { class: 'mono', href: `/receipt/${p.settlement_ref.receipt_id}` }, p.settlement_ref.receipt_id)])
  else rows.push(['Settlement', 'None on-chain before this refund'])
  if (p.previous_receipt_id) rows.push(['Previous receipt', h('a', { class: 'mono', href: `/receipt/${p.previous_receipt_id}` }, p.previous_receipt_id)])
  rows.push(['Issued', new Date(p.issued_at).toLocaleString()], ['Receipt id', h('span', { class: 'mono' }, p.receipt_id)])
  $('#details').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))
}

function details(p, meta) {
  if (p.receipt_type === 'refund_notice') return refundDetails(p)
  const s = p.settlement, a = p.amounts
  const rows = [
    ['Order', h('span', { class: 'mono' }, p.order.id)],
    ['Pix amount', `${brl(p.order.amount.amount)} (${p.provider_env})`],
    ['Merchant received', h('b', {}, `${units(a.net, a.scale)} ${a.currency}`)],
    ['Reserve', `${units(a.reserve_simulated, a.scale)} ${a.currency} (simulated accounting)`],
    ['Gross', `${units(a.gross, a.scale)} ${a.currency}`],
    ['Quote', `${p.quote.rate_num}/${p.quote.rate_den} token units per centavo (simulated)`],
    ['Paid to', h('span', { class: 'mono' }, s.to)],
    ['Transaction', h('a', { class: 'mono', href: `${meta.chain.explorer}/tx/${s.tx_hash}`, target: '_blank', rel: 'noopener' }, short(s.tx_hash, 10))],
    ['Block', s.block_number],
    ['Memo', h('span', { class: 'mono' }, memoText(s.memo) || s.memo)],
    ['Issued', new Date(p.issued_at).toLocaleString()],
    ['Receipt id', h('span', { class: 'mono' }, p.receipt_id)],
  ]
  $('#details').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))
}
providerBadge()
run()
