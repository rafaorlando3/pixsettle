import './verify.js'
import { $, h, brl, units, short, api } from './common.js'

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
  await verify(env, trusted, meta)
}

async function verify(env, trusted, meta) {
  hero('run', 'Verifying', 'Checking the signature and reading the transaction from Tempo.')
  $('#steps').replaceChildren(h('div', { class: 'step' }, h('span', { class: 'ico run' }, h('span', { class: 'spin' })), h('div', {}, 'Running checks...')))
  const steps = await globalThis.PixSettleVerify.verifyReceipt(env, trusted, meta.chain.rpc)
  $('#steps').replaceChildren(...steps.map(s => h('div', { class: 'step' },
    h('span', { class: `ico ${s.state}` }, ICON[s.state]),
    h('div', {}, h('div', { class: 'strong' }, s.label), h('div', { class: 'small muted' }, s.detail)))))
  const fail = steps.some(s => s.state === 'fail'), unavailable = steps.some(s => s.state === 'unavailable')
  if (fail) hero('bad', 'Verification failed', 'Do not trust this receipt. See the failing check below.')
  else if (unavailable) hero('warn', 'Signature valid, chain check unavailable', 'The Tempo RPC could not be reached. Try again in a moment.')
  else hero('ok', 'Receipt verified', 'Signed by a trusted issuer and matched to a successful transfer on Tempo.')
}

function details(p, meta) {
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
run()
