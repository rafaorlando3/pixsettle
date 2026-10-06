// Carrega um arquivo NDJSON de eventos atestados (exportação pseudonimizada da loja) no core, em lotes assinados.
//
//   PILOT_HMAC_SECRET=... npx tsx scripts/pilot-load.ts --url https://host --file eventos.ndjson [--source odin] [--batch 200] [--dry]
//
// Ordena por horário antes de enviar (pedido antes da cobrança, cobrança antes do Pix), conta recusas do guarda
// por motivo e termina com código 1 se algo foi recusado ou se o servidor não processou tudo.
import { readFileSync } from 'node:fs'
import { guardLine, signBody } from '../src/pilot/guard.js'
import { BATCH_CONTENT_TYPE } from '../src/pilot/routes.js'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? '1' : all[i + 1]] : []).filter(x => x.length))
const file = args.file, url = (args.url ?? '').replace(/\/$/, ''), source = args.source ?? 'odin', size = Math.max(1, Math.min(2000, Number(args.batch ?? 200)))
const dry = args.dry === '1'
const secret = process.env.PILOT_HMAC_SECRET ?? ''
if (!file) { console.error('uso: --file eventos.ndjson --url https://host [--source odin] [--batch 200] [--dry]'); process.exit(2) }
if (!dry && (!url || !secret)) { console.error('faltam --url e PILOT_HMAC_SECRET (ou use --dry)'); process.exit(2) }

const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
const parsed: Array<{ i: number; line: any }> = []
const rejected: Record<string, number> = {}
lines.forEach((l, i) => {
  let obj: unknown
  try { obj = JSON.parse(l) } catch { rejected['invalid_json'] = (rejected['invalid_json'] ?? 0) + 1; return }
  const g = guardLine(obj)
  if (!g.ok) { rejected[g.reason] = (rejected[g.reason] ?? 0) + 1; return }
  parsed.push({ i, line: g.line })
})
// Ordem: horário, depois a ordem natural dos tipos para o mesmo instante (pedido < cobrança < Pix < resto).
const rank = (ev: string) => ev === 'order.created' ? 0 : ev === 'pix.charge.created' ? 1 : ev === 'pix.received' ? 2 : 3
parsed.sort((a, b) => String(a.line.ts ?? '').localeCompare(String(b.line.ts ?? '')) || rank(a.line.ev) - rank(b.line.ev) || a.i - b.i)
console.log(`linhas: ${lines.length}; válidas: ${parsed.length}; recusadas pelo guarda: ${JSON.stringify(rejected)}`)
if (dry) process.exit(Object.keys(rejected).length ? 1 : 0)

let accepted = 0, duplicates = 0, serverRejected = 0, processed = 0, deferred = 0, unmapped = 0, ignored = 0, errors = 0
for (let b = 0; b * size < parsed.length; b++) {
  const batch = parsed.slice(b * size, (b + 1) * size).map(x => x.line)
  const body = JSON.stringify({ source, batch_id: `${file.split('/').pop()}:${b + 1}`, events: batch })
  const r = await fetch(`${url}/pilot/v1/events`, { method: 'POST', headers: { 'content-type': BATCH_CONTENT_TYPE, 'x-pilot-signature': signBody(secret, body) }, body })
  const text = await r.text()
  if (!r.ok) { console.error(`lote ${b + 1}: HTTP ${r.status}: ${text.slice(0, 300)}`); process.exit(1) }
  const j = JSON.parse(text)
  accepted += j.accepted; duplicates += j.duplicates; serverRejected += j.rejected.length
  if (j.processed) { processed += j.processed.processed; deferred += j.processed.deferred; unmapped += j.processed.unmapped; ignored += j.processed.ignored; errors += j.processed.errors }
  if (j.rejected.length) console.error(`lote ${b + 1}: ${j.rejected.length} recusadas pelo servidor: ${JSON.stringify(j.rejected.slice(0, 3))}`)
  process.stdout.write(`lote ${b + 1}/${Math.ceil(parsed.length / size)}: +${j.accepted} dup ${j.duplicates}\r`)
}
console.log(`\naceitas: ${accepted}; duplicadas: ${duplicates}; recusadas pelo servidor: ${serverRejected}`)
console.log(`processadas: ${processed}; ignoradas (só estatística): ${ignored}; adiadas: ${deferred}; sem mapa: ${unmapped}; erros: ${errors}`)
process.exit(serverRejected || errors || deferred ? 1 : 0)
