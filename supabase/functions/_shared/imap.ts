// Pure IMAP / RFC822 parsing helpers for the `email-poll` function.
//
// Socket I/O and IMAP framing (command tags, {N} literals) live in the function;
// everything here is pure and unit-tested (tests/imap_test.ts). The function
// accumulates each message's raw RFC822 bytes (via the FETCH literal) and hands
// the string here to be turned into a normalized {from, subject, text, …}.
//
// Scope is a pragmatic MVP: headers (folded + RFC2047 encoded-words), a readable
// text body (prefer text/plain, fall back to stripped text/html), and the common
// transfer encodings (base64 / quoted-printable). Good enough to land mail in the
// inbox; not a full MIME tree.

export interface ParsedEmail {
  from: string
  fromName: string
  to: string
  subject: string
  date: string
  messageId: string
  text: string
}

// Parse the UID list from an IMAP SEARCH response, e.g. "* SEARCH 2 3 5" -> [2,3,5].
export function parseSearchUids(response: string): number[] {
  const uids: number[] = []
  for (const line of response.split(/\r?\n/)) {
    const m = line.match(/^\*\s+SEARCH\b(.*)$/i)
    if (!m) continue
    for (const tok of m[1].trim().split(/\s+/)) {
      const n = Number(tok)
      if (Number.isInteger(n) && n > 0) uids.push(n)
    }
  }
  return uids
}

// Pull the UID out of a FETCH response header line, e.g.
// "* 3 FETCH (UID 42 BODY[] {123}" -> 42.
export function parseFetchUid(line: string): number | null {
  const m = line.match(/\bUID\s+(\d+)/i)
  return m ? Number(m[1]) : null
}

// Split a raw RFC822 message into its header block and body.
export function splitHeaderBody(raw: string): { header: string; body: string } {
  const m = raw.match(/\r?\n\r?\n/)
  if (!m || m.index === undefined) return { header: raw, body: '' }
  return { header: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) }
}

// Parse folded RFC822 headers into a case-insensitive map (first occurrence wins,
// which is correct for the singleton headers we read: From/To/Subject/Date/…).
export function parseHeaders(header: string): Map<string, string> {
  const out = new Map<string, string>()
  const unfolded = header.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([!-9;-~]+):[ \t]?(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    if (!out.has(key)) out.set(key, m[2])
  }
  return out
}

// Recover the original bytes from a string that preserved them 1:1 (latin1), the
// way the poll function decodes an IMAP literal before parsing.
function latin1ToBytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '')
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  const cs = (charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '')
  try {
    return new TextDecoder(cs).decode(bytes)
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytes)
    } catch {
      let s = ''
      for (const b of bytes) s += String.fromCharCode(b)
      return s
    }
  }
}

function charsetOf(contentType: string): string {
  return contentType.match(/charset=("?)([^";]+)\1/i)?.[2] ?? 'utf-8'
}

// Decode an RFC2047 encoded-word run in a header, e.g.
// "=?utf-8?B?...?=" / "=?utf-8?Q?...?=". Whitespace between adjacent encoded
// words is dropped per spec.
export function decodeMimeWords(input: string): string {
  if (!input) return ''
  const joined = input.replace(/\?=[ \t]+=\?/g, '?==?')
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_full, charset, enc, text) => {
    try {
      let bytes: Uint8Array
      if (enc.toUpperCase() === 'B') {
        bytes = base64ToBytes(text)
      } else {
        const q = text
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)))
        bytes = Uint8Array.from(q, (c: string) => c.charCodeAt(0) & 0xff)
      }
      return decodeCharset(bytes, charset)
    } catch {
      return text
    }
  })
}

export function decodeQuotedPrintable(input: string, charset = 'utf-8'): string {
  const noSoft = input.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < noSoft.length; i++) {
    const c = noSoft[i]
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(noSoft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(noSoft.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(c.charCodeAt(0) & 0xff)
    }
  }
  return decodeCharset(Uint8Array.from(bytes), charset)
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

interface MimePart {
  headers: Map<string, string>
  body: string
}

function parsePart(raw: string): MimePart {
  const { header, body } = splitHeaderBody(raw)
  return { headers: parseHeaders(header), body }
}

function decodeTransfer(body: string, enc: string, contentType: string): string {
  const e = enc.trim().toLowerCase()
  if (e === 'base64') {
    try {
      return decodeCharset(base64ToBytes(body), charsetOf(contentType))
    } catch {
      return body
    }
  }
  if (e === 'quoted-printable') return decodeQuotedPrintable(body, charsetOf(contentType))
  // 7bit / 8bit / binary / none: the body may be raw UTF-8 (or another charset)
  // carried through as latin1-preserved bytes by the poll function — re-decode
  // under the declared charset so 8-bit text isn't mojibake.
  const cs = charsetOf(contentType).toLowerCase()
  if (cs !== 'us-ascii' && cs !== 'ascii') return decodeCharset(latin1ToBytes(body), cs)
  return body
}

// Split a multipart body on its boundary into raw part strings (preamble +
// closing epilogue dropped).
function splitMultipart(body: string, boundary: string): string[] {
  const segments = body.split('--' + boundary)
  const parts: string[] = []
  for (let i = 1; i < segments.length; i++) {
    let seg = segments[i]
    if (seg.startsWith('--')) break // closing --boundary--
    seg = seg.replace(/^\r?\n/, '')
    parts.push(seg)
  }
  return parts
}

function partText(part: MimePart, depth = 0): string {
  const ctype = part.headers.get('content-type') ?? 'text/plain'
  const boundary = ctype.match(/boundary=("?)([^";]+)\1/i)?.[2]
  if (/multipart\//i.test(ctype) && boundary && depth < 8) {
    const subs = splitMultipart(part.body, boundary).map(parsePart)
    const plain = subs.find((s) => /text\/plain/i.test(s.headers.get('content-type') ?? 'text/plain'))
    if (plain) return partText(plain, depth + 1)
    const html = subs.find((s) => /text\/html/i.test(s.headers.get('content-type') ?? ''))
    if (html) return partText(html, depth + 1)
    for (const s of subs) {
      if (/multipart\//i.test(s.headers.get('content-type') ?? '')) {
        const t = partText(s, depth + 1)
        if (t) return t
      }
    }
    return ''
  }
  const enc = part.headers.get('content-transfer-encoding') ?? ''
  const decoded = decodeTransfer(part.body, enc, ctype)
  return /text\/html/i.test(ctype) ? stripHtml(decoded) : decoded
}

// Extract a readable text body from a full RFC822 message.
export function extractTextBody(raw: string): string {
  return partText(parsePart(raw)).trim()
}

// Parse a From/To style address into a display name + bare address.
export function parseAddress(s: string): { name: string; address: string } {
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim(), address: m[2].trim() }
  return { name: '', address: s.trim() }
}

// Turn a full RFC822 message into the normalized shape the inbox stores.
export function parseEmailMessage(raw: string): ParsedEmail {
  const { header } = splitHeaderBody(raw)
  const h = parseHeaders(header)
  const fromRaw = decodeMimeWords(h.get('from') ?? '')
  const { name, address } = parseAddress(fromRaw)
  return {
    from: address || fromRaw,
    fromName: name,
    to: decodeMimeWords(h.get('to') ?? ''),
    subject: decodeMimeWords(h.get('subject') ?? ''),
    date: (h.get('date') ?? '').trim(),
    messageId: (h.get('message-id') ?? '').replace(/^<|>$/g, '').trim(),
    text: extractTextBody(raw),
  }
}
