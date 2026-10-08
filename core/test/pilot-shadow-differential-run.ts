/** Replay every call harvested from the unchanged 33 Python E1 v1.7 tests against the TS port. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseContractJson, parseKeyring, validateFeed, checkPronto, nextCheckpoint, readBounded, TooLarge } from '../src/pilot-shadow/guard.js'
import { main } from '../scripts/pilot-shadow-validate.js'
const un = (v: any): any => v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v._bytes === 'string' ? Buffer.from(v._bytes, 'base64') : Array.isArray(v) ? v.map(un) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, un(x)])) : v
const pack = (v: any): any => Buffer.isBuffer(v) ? { _bytes: v.toString('base64') } : Array.isArray(v) ? v.map(pack) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)])) : v
let n = 0, failed = 0
for (const line of readFileSync(process.argv[2]!, 'utf8').trimEnd().split('\n')) {
  const c = JSON.parse(line); let got: any
  const dir = mkdtempSync(join(tmpdir(), 'e1-differential-'))
  try {
    if (c.op === 'validate') got = validateFeed(un(c.raw), parseContractJson(c.att_json), un(c.ring), c.expect)
    else if (c.op === 'pronto') { const a = un(c.args); got = checkPronto(a[0], a[1], a[2], a[3], a[4]) }
    else if (c.op === 'checkpoint') got = nextCheckpoint(c.args[0], c.args[1])
    else if (c.op === 'keyring') { try { got = { ok: true, ring: pack(parseKeyring(un(c.data), c.env)) } } catch { got = { ok: false } } }
    else if (c.op === 'bounded') { const p = join(dir, 'file'); writeFileSync(p, un(c.data)); try { got = { ok: true, data: pack(readBounded(p, c.limit)) } } catch (e) { if (!(e instanceof TooLarge)) throw e; got = { ok: false } } }
    else if (c.op === 'cli') {
      for (const [name, data] of Object.entries(un(c.files))) writeFileSync(join(dir, name), data as Buffer)
      const env: Record<string, string> = { E1_T_SECRET: 'a'.repeat(40) }
      if (c.ring_json !== null) { writeFileSync(join(dir, 'ring.json'), c.ring_json); env.PIXSETTLE_SHADOW_KEYRING = join(dir, 'ring.json') }
      const a = [join(dir, 'LOTE-n.jsonl'), join(dir, 'ATESTADO-n.json'), '--origin', 'src_1', '--store', 'store_1', ...c.extra.map((x: string) => x.startsWith('--') ? x : join(dir, x))]
      const r = main(a, env); got = [r.code, r.output]
    }
    if (JSON.stringify(pack(got)) !== JSON.stringify(c.expected)) { failed++; process.stderr.write(JSON.stringify({ case: n + 1, op: c.op, expected: c.expected, got: pack(got) }) + '\n') }
  } finally { rmSync(dir, { recursive: true, force: true }) }
  n++
}
process.stdout.write(JSON.stringify({ differential_cases: n, passed: n - failed, failed }) + '\n'); process.exitCode = failed ? 1 : 0
