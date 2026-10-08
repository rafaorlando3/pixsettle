// Bounded transport only. The guard separately checks PRONTO and the attestation
// over the original bytes. Framing never reserializes any of the three files.
export const SHADOW_CONTENT_TYPE = 'application/x-pixsettle-shadow-trio'
export const MAX_LOTE = 5000 * 2049
export const MAX_ATT = 8192
export const MAX_PRONTO = 1024
export const MAX_META = 1024
const MAGIC = Buffer.from('PIXSETTLE-SHADOW-TRIO/1\n')
export const MAX_FRAME = MAGIC.length + 16 + MAX_META + MAX_LOTE + MAX_ATT + MAX_PRONTO

export type RawShadowTrio = {
  lote: Buffer; atestado: Buffer; pronto: Buffer
  loteName: string; atestadoName: string; prontoName: string
}
export class ShadowFrameError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ShadowFrameError' }
}

function names(meta: unknown): Pick<RawShadowTrio, 'loteName' | 'atestadoName' | 'prontoName'> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new ShadowFrameError('frame_names')
  const value = meta as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'atestadoName,loteName,prontoName') throw new ShadowFrameError('frame_names')
  const stem = typeof value.prontoName === 'string' ? /^PRONTO-([A-Za-z0-9_-]{1,190})\.json$/.exec(value.prontoName)?.[1] : null
  if (!stem || value.loteName !== `LOTE-${stem}.jsonl` || value.atestadoName !== `ATESTADO-${stem}.json`) throw new ShadowFrameError('frame_names')
  return { loteName: value.loteName as string, atestadoName: value.atestadoName as string, prontoName: value.prontoName as string }
}

export function encodeTrio(trio: RawShadowTrio): Buffer {
  const metadata = names({ loteName: trio.loteName, atestadoName: trio.atestadoName, prontoName: trio.prontoName })
  const parts = [Buffer.from(JSON.stringify(metadata)), trio.lote, trio.atestado, trio.pronto]
  const limits = [MAX_META, MAX_LOTE, MAX_ATT, MAX_PRONTO]
  const chunks: Buffer[] = [MAGIC]
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (!Buffer.isBuffer(part) || part.length === 0 || part.length > limits[i]!) throw new ShadowFrameError('frame_length')
    const length = Buffer.alloc(4); length.writeUInt32BE(part.length)
    chunks.push(length, part)
  }
  return Buffer.concat(chunks)
}

export function decodeTrio(raw: Buffer): RawShadowTrio {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_FRAME || raw.length < MAGIC.length + 16 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new ShadowFrameError('frame_header')
  const limits = [MAX_META, MAX_LOTE, MAX_ATT, MAX_PRONTO]
  const parts: Buffer[] = []
  let pos = MAGIC.length
  for (const limit of limits) {
    if (pos + 4 > raw.length) throw new ShadowFrameError('frame_truncated')
    const length = raw.readUInt32BE(pos); pos += 4
    if (!length || length > limit) throw new ShadowFrameError('frame_length')
    if (pos + length > raw.length) throw new ShadowFrameError('frame_truncated')
    parts.push(Buffer.from(raw.subarray(pos, pos + length))); pos += length
  }
  if (pos !== raw.length) throw new ShadowFrameError('frame_trailing_bytes')
  let metadata: unknown
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(parts[0]!)) }
  catch { throw new ShadowFrameError('frame_metadata_json') }
  return { ...names(metadata), lote: parts[1]!, atestado: parts[2]!, pronto: parts[3]! }
}
