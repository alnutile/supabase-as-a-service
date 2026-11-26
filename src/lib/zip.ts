// A tiny, dependency-free ZIP writer (STORE method - no compression).
//
// The workspace export is mostly markdown and JSON, a few MB at most, so a
// stored zip is fine and avoids pulling a compression library into the bundle.
// Every unzip tool (Finder, Explorer, `unzip`, Python's zipfile) reads it.
// Pure + synchronous so it's unit-testable without a browser.

export type ZipEntry = {
  /** Path inside the archive, forward slashes, no leading slash. */
  path: string
  data: string | Uint8Array
  /** Modification time recorded in the archive (defaults to now). */
  date?: Date
}

let CRC_TABLE: Uint32Array | null = null

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  CRC_TABLE = table
  return table
}

/** Standard CRC-32 (the one ZIP uses). */
export function crc32(bytes: Uint8Array): number {
  const table = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS time/date fields used by the ZIP headers (local time, 2s precision). */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()))
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** Build a complete .zip archive from the given entries. */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = enc.encode(entry.path)
    const data = typeof entry.data === 'string' ? enc.encode(entry.data) : entry.data
    const crc = crc32(data)
    const { time, date } = dosDateTime(entry.date ?? new Date())
    // Bit 11 = filenames are UTF-8, so non-ASCII titles survive.
    const flags = 0x0800

    const local = new Uint8Array(30 + name.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, flags, true)
    lv.setUint16(8, 0, true) // method: store
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, flags, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    // extra len, comment len, disk start, internal attrs, external attrs = 0
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + end.length)
  let p = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p)
    p += part.length
  }
  return out
}
