// Utilitários das páginas (sem dependências externas).
export const $ = (sel, root = document) => root.querySelector(sel)
export const brl = (minor) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(minor) / 100)
export const units = (u, scale = 6) => {
  const s = BigInt(u).toString().padStart(scale + 1, '0')
  const int = s.slice(0, -scale), frac = s.slice(-scale).replace(/0+$/, '').padEnd(2, '0')
  return `${Number(int).toLocaleString('en-US')}.${frac}`
}
export const short = (h, n = 6) => h ? `${h.slice(0, n + 2)}...${h.slice(-4)}` : ''
export function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return e
}
export function toast(msg) {
  let t = $('.toast')
  if (!t) { t = h('div', { class: 'toast', role: 'status' }); document.body.append(t) }
  t.textContent = msg; t.classList.add('show')
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1800)
}
export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied') } catch { toast('Copy not available here') }
}
export async function api(path, init) {
  const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(body?.error?.message ?? `HTTP ${r.status}`), { status: r.status, body })
  return body
}
