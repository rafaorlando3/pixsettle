/** CLI parity with validar_feed.py E1 v1.7. Performs no ingestion and never prints input fields or values. */
import { basename } from 'node:path'
import { readBounded, TooLarge, MAX_LOTE_BYTES, MAX_ATT_BYTES, MAX_PRONTO_BYTES, MAX_KEYRING_BYTES, parseContractJson, parseKeyring, validateFeed, checkPronto } from '../src/pilot-shadow/guard.js'
export function main(args: string[], environ: Record<string, string | undefined> = process.env): { code: number; output: string } {
  const out = (code: number, message: string) => ({ code, output: message + '\n' })
  try {
    if (!([6, 8].includes(args.length) && args[2] === '--origin' && args[4] === '--store' && (args.length === 6 || args[6] === '--pronto'))) return out(1, 'uso: validar_feed.py LOTE.jsonl ATESTADO.json --origin src_N --store store_N [--pronto PRONTO.json]')
    let raw: Buffer, attRaw: Buffer, pronto: Buffer | null
    try { raw = readBounded(args[0]!, MAX_LOTE_BYTES); attRaw = readBounded(args[1]!, MAX_ATT_BYTES); pronto = args.length === 8 ? readBounded(args[7]!, MAX_PRONTO_BYTES) : null }
    catch (e: any) { return e instanceof TooLarge ? out(1, 'arquivo acima do teto: nao ingerir') : out(1, 'erro de leitura: ' + (e.code === 'ENOENT' ? 'FileNotFoundError' : 'OSError')) }
    let att: any; try { att = parseContractJson(attRaw) } catch { att = null }
    let ring = null
    try { if (environ.PIXSETTLE_SHADOW_KEYRING) ring = parseKeyring(readBounded(environ.PIXSETTLE_SHADOW_KEYRING, MAX_KEYRING_BYTES), environ) } catch { return out(1, 'keyring invalido') }
    const [errors, signed] = validateFeed(raw, att, ring, [args[3]!, args[5]!])
    if (pronto) errors.push(...checkPronto(pronto, raw, attRaw, basename(args[0]!), basename(args[1]!)))
    if (errors.length) return out(1, errors.join('\n'))
    if (!signed) return out(2, 'forma ok, assinatura NAO conferida (sem PIXSETTLE_SHADOW_KEYRING): nao ingerir')
    if (pronto === null) return out(2, 'forma e assinatura ok, PRONTO NAO conferido (sem --pronto): nao ingerir')
    return out(0, `ok ${att.count} eventos, assinatura e PRONTO conferidos (${att.key_id})`)
  } catch { return out(1, 'erro interno do validador: nao ingerir') }
}
if (import.meta.url === new URL(process.argv[1]!, 'file:').href) { const result = main(process.argv.slice(2)); process.stdout.write(result.output); process.exitCode = result.code }
