import { $, h, brl, copy } from './common.js'

const token = location.pathname.split('/').pop()
let last = null, timer = null

function countdown(expires) {
  const s = Math.max(0, Math.floor((new Date(expires) - Date.now()) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function render(c) {
  $('#amount').textContent = brl(c.amount.amount)
  const state = $('#state'), body = $('#body')
  const key = c.status + (c.pix_payload ? '1' : '0')
  if (key === last) { const cd = $('#cd'); if (cd) cd.textContent = countdown(c.expires_at); return }
  last = key
  state.replaceChildren(); body.replaceChildren()
  if (c.status === 'awaiting_payment' && c.pix_payload) {
    state.append(h('span', { class: 'badge warn' }, h('span', { class: 'pulse' }), 'Waiting for payment'))
    body.append(
      h('div', { class: 'qr' }, h('img', { src: `/api/v1/checkout/${token}/qr.svg`, alt: 'Pix QR code', width: 200, height: 200 })),
      h('div', { class: 'small muted scan' }, 'Scan with your bank app, or copy the code'),
      h('div', { class: 'code' }, h('span', { class: 'mono' }, c.pix_payload), h('button', { class: 'ghost', onclick: () => copy(c.pix_payload) }, 'Copy')),
      h('p', { class: 'small muted' }, 'Expires in ', h('b', { id: 'cd' }, countdown(c.expires_at))),
    )
  } else if (c.status === 'paid') {
    state.append(h('span', { class: 'badge ok' }, 'Paid'))
    body.append(h('div', { class: 'check' }, '✓'), h('div', { class: 'done' }, 'Payment received'), h('p', { class: 'muted' }, 'The store has been notified. You can close this page.'))
  } else if (c.status === 'under_review') {
    state.append(h('span', { class: 'badge warn' }, 'Under review'))
    body.append(h('div', { class: 'check warn' }, '!'), h('div', { class: 'done' }, 'Payment under review'), h('p', { class: 'muted' }, 'We received a payment that needs a quick check. The store will contact you.'))
  } else if (c.status === 'expired' || c.status === 'late_paid') {
    state.append(h('span', { class: 'badge bad' }, 'Expired'))
    body.append(h('p', { class: 'muted' }, 'This Pix code has expired. If you paid after the deadline, the amount will be refunded.'))
  } else {
    state.append(h('span', { class: 'badge muted' }, h('span', { class: 'spin' }), 'Preparing your Pix code'))
  }
}

async function tick() {
  try {
    const r = await fetch(`/api/v1/checkout/${encodeURIComponent(token)}`)
    if (r.status === 404) { $('#state').replaceChildren(h('span', { class: 'badge bad' }, 'Invalid checkout link')); return }
    if (r.status === 410) { // link vencido: sem valor, código ou QR; só o estado
      const st = (await r.json()).error?.details?.status
      $('#amount').textContent = ''
      $('#state').replaceChildren(h('span', { class: `badge ${st === 'paid' ? 'ok' : 'bad'}` }, st === 'paid' ? 'Paid' : 'Link expired'))
      $('#body').replaceChildren(st === 'paid'
        ? h('div', {}, h('div', { class: 'check' }, '✓'), h('div', { class: 'done' }, 'Payment received'), h('p', { class: 'muted' }, 'This link has expired, but your payment was received.'))
        : h('p', { class: 'muted' }, 'This payment link has expired. Ask the store for a new one. Do not pay an old Pix code.'))
      return
    }
    const c = await r.json()
    render(c)
    if (['paid', 'under_review', 'expired', 'late_paid'].includes(c.status)) return
  } catch { /* rede instável: tenta de novo */ }
  timer = setTimeout(tick, 1000)
}
tick()
