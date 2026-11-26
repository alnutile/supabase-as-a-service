import { describe, expect, it } from 'vitest'
import { crc32, createZip, dosDateTime } from './zip'

// Minimal reader: walk the central directory and pull each stored file back out.
function readZip(buf: Uint8Array): Record<string, string> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const eocd = buf.length - 22
  expect(v.getUint32(eocd, true)).toBe(0x06054b50)
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out: Record<string, string> = {}
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50)
    const crc = v.getUint32(p + 16, true)
    const size = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const localOff = v.getUint32(p + 42, true)
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))
    expect(v.getUint32(localOff, true)).toBe(0x04034b50)
    const lNameLen = v.getUint16(localOff + 26, true)
    const start = localOff + 30 + lNameLen
    const data = buf.subarray(start, start + size)
    expect(crc32(data)).toBe(crc)
    out[name] = dec.decode(data)
    p += 46 + nameLen
  }
  return out
}

describe('crc32', () => {
  it('matches known values', () => {
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686)
    expect(crc32(new Uint8Array())).toBe(0)
  })
})

describe('dosDateTime', () => {
  it('packs local date/time and clamps pre-1980', () => {
    const { date, time } = dosDateTime(new Date(2026, 10, 26, 13, 45, 31))
    expect(date).toBe(((2026 - 1980) << 9) | (11 << 5) | 26)
    expect(time).toBe((13 << 11) | (45 << 5) | 15)
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0)
  })
})

describe('createZip', () => {
  it('round-trips text and binary entries with UTF-8 names', () => {
    const zip = createZip([
      { path: 'README.md', data: '# hi' },
      { path: 'artifacts/Café ☕.md', data: 'naïve' },
      { path: 'bin.dat', data: new Uint8Array([0, 1, 2, 255]) },
    ])
    const files = readZip(zip)
    expect(Object.keys(files)).toEqual(['README.md', 'artifacts/Café ☕.md', 'bin.dat'])
    expect(files['README.md']).toBe('# hi')
    expect(files['artifacts/Café ☕.md']).toBe('naïve')
  })

  it('produces a valid empty archive', () => {
    const zip = createZip([])
    expect(zip.length).toBe(22)
    expect(readZip(zip)).toEqual({})
  })
})
