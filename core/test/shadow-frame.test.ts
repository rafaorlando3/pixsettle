import { describe, it, expect } from 'vitest'
import { decodeTrio, encodeTrio, MAX_LOTE, MAX_FRAME, ShadowFrameError } from '../src/pilot-shadow/frame.js'
const trio = () => ({ lote: Buffer.from('{"a": 15}\n'), atestado: Buffer.from('{"sig":"original"}\n'), pronto: Buffer.from('{"sha256":"original"}\n'), loteName: 'LOTE-store_1-test.jsonl', atestadoName: 'ATESTADO-store_1-test.json', prontoName: 'PRONTO-store_1-test.json' })
describe('shadow trio byte transport', () => {
  it('preserves original file bytes, including spaces and final newlines', () => {
    const original = trio(), decoded = decodeTrio(encodeTrio(original))
    expect(decoded).toEqual(original)
    decoded.lote.fill(0)
    expect(original.lote.toString()).toBe('{"a": 15}\n')
  })
  it('rejects a path traversal filename without echoing it', () => {
    const bad = { ...trio(), prontoName: 'PRONTO-../../private.json' }
    expect(() => encodeTrio(bad)).toThrowError('frame_names')
  })
  it('rejects mismatched file stems', () => {
    expect(() => encodeTrio({ ...trio(), atestadoName: 'ATESTADO-store_2-test.json' })).toThrowError('frame_names')
  })
  it('refuses oversized files before building the frame', () => {
    expect(() => encodeTrio({ ...trio(), lote: Buffer.alloc(MAX_LOTE + 1) })).toThrowError('frame_length')
  })
  it('refuses oversized transport before parsing', () => {
    expect(() => decodeTrio(Buffer.alloc(MAX_FRAME + 1))).toThrowError('frame_header')
  })
  it('rejects trailing bytes rather than leaving an unsigned second message', () => {
    expect(() => decodeTrio(Buffer.concat([encodeTrio(trio()), Buffer.from('extra')]))).toThrowError('frame_trailing_bytes')
  })
  it('rejects every truncation of a valid frame', () => {
    const frame = encodeTrio(trio())
    for (let n = 0; n < frame.length; n++) expect(() => decodeTrio(frame.subarray(0, n))).toThrow(ShadowFrameError)
  })
  it('rejects claimed lengths beyond the available body', () => {
    const frame = encodeTrio(trio())
    frame.writeUInt32BE(500, Buffer.byteLength('PIXSETTLE-SHADOW-TRIO/1\n'))
    expect(() => decodeTrio(frame)).toThrowError('frame_truncated')
  })
})
