// Minimal IMAP client for the `imap-poll` connector.
//
// Edge functions are request-scoped, so we can't hold a live IMAP socket open.
// Instead each poll does a short connect → login → SELECT → UID SEARCH → UID
// FETCH → (optional \Seen) → LOGOUT over a TLS socket (Deno.connectTls), then
// disconnects. We deliberately implement just enough of RFC 3501 rather than
// pulling a Node-oriented IMAP library into the edge runtime.
//
// The wire-parsing logic is split out as pure/injectable pieces so it can be
// unit-tested without a real server (tests/imap_test.ts): `ImapReader` reads
// lines + literals from any byte source, `readLineResponse` / `readFetchMessages`
// drive a command's response off a reader, and `parseSearchUids` / `parseSelect`
// / `selectNewUids` are pure string/array helpers.

const CR = 13
const LF = 10
const latin1 = new TextDecoder('latin1')
const encoder = new TextEncoder()

/** Anything with Deno.Reader's shape — a TLS conn in prod, a canned buffer in tests. */
export interface ByteSource {
  read(p: Uint8Array): Promise<number | null>
}

/** Buffered reader that can pull a CRLF-terminated line or an exact N bytes
 *  (IMAP literals), honoring the `{n}` byte counts so binary bodies never get
 *  mis-split on a stray CRLF. */
export class ImapReader {
  #src: ByteSource
  #buf: Uint8Array = new Uint8Array(0)

  constructor(src: ByteSource) {
    this.#src = src
  }

  async #fill(): Promise<boolean> {
    const tmp = new Uint8Array(16384)
    const n = await this.#src.read(tmp)
    if (n === null || n === 0) return false
    const next = new Uint8Array(this.#buf.length + n)
    next.set(this.#buf, 0)
    next.set(tmp.subarray(0, n), this.#buf.length)
    this.#buf = next
    return true
  }

  /** Next line without its trailing CR/LF, or null at end of stream. */
  async readLine(): Promise<string | null> {
    while (true) {
      const idx = this.#buf.indexOf(LF)
      if (idx !== -1) {
        let end = idx
        if (end > 0 && this.#buf[end - 1] === CR) end -= 1
        const line = latin1.decode(this.#buf.subarray(0, end))
        this.#buf = this.#buf.slice(idx + 1)
        return line
      }
      const more = await this.#fill()
      if (!more) {
        if (this.#buf.length === 0) return null
        const line = latin1.decode(this.#buf)
        this.#buf = new Uint8Array(0)
        return line
      }
    }
  }

  /** Exactly `n` bytes (an IMAP literal); short read only at end of stream. */
  async readBytes(n: number): Promise<Uint8Array> {
    while (this.#buf.length < n) {
      const more = await this.#fill()
      if (!more) break
    }
    const take = Math.min(n, this.#buf.length)
    const out = this.#buf.slice(0, take)
    this.#buf = this.#buf.slice(take)
    return out
  }
}

const LITERAL = /\{(\d+)\}\s*$/

function tagRe(tag: string): RegExp {
  return new RegExp('^' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (OK|NO|BAD)\\b', 'i')
}

export interface SimpleResponse {
  ok: boolean
  code: 'OK' | 'NO' | 'BAD'
  lines: string[]
}

/** Read a command's untagged lines up to its tagged `<tag> OK|NO|BAD` line.
 *  Consumes (and discards) any literals — the commands that use this
 *  (LOGIN/SELECT/SEARCH/STORE) don't return meaningful ones. */
export async function readLineResponse(reader: ImapReader, tag: string): Promise<SimpleResponse> {
  const lines: string[] = []
  const done = tagRe(tag)
  while (true) {
    const line = await reader.readLine()
    if (line === null) throw new Error('IMAP connection closed mid-response')
    const lit = line.match(LITERAL)
    if (lit) {
      await reader.readBytes(Number(lit[1]))
      lines.push(line)
      continue
    }
    lines.push(line)
    const m = line.match(done)
    if (m) return { ok: m[1].toUpperCase() === 'OK', code: m[1].toUpperCase() as 'OK' | 'NO' | 'BAD', lines }
  }
}

export interface FetchedMessage {
  uid: number
  body: Uint8Array
}

/** Read a `UID FETCH … (UID BODY.PEEK[])` response into per-message raw bodies.
 *  Each `* n FETCH (…)` item carries its UID on the opening line and its raw
 *  RFC822 message as the single literal we requested. */
export async function readFetchMessages(reader: ImapReader, tag: string): Promise<FetchedMessage[]> {
  const out: FetchedMessage[] = []
  const done = tagRe(tag)
  let cur: { uid: number; body: Uint8Array | null } | null = null
  const flush = () => {
    if (cur && cur.body) out.push({ uid: cur.uid, body: cur.body })
    cur = null
  }
  while (true) {
    const line = await reader.readLine()
    if (line === null) break
    if (/^\* \d+ FETCH /i.test(line)) {
      flush()
      cur = { uid: 0, body: null }
    }
    if (cur) {
      const um = line.match(/\bUID (\d+)/i)
      if (um) cur.uid = Number(um[1])
    }
    const lit = line.match(LITERAL)
    if (lit) {
      const bytes = await reader.readBytes(Number(lit[1]))
      if (cur) cur.body = bytes
      continue
    }
    if (done.test(line)) break
  }
  flush()
  return out
}

/** UIDs from one or more `* SEARCH 1 2 3` untagged lines. */
export function parseSearchUids(lines: string[]): number[] {
  const uids: number[] = []
  for (const line of lines) {
    const m = line.match(/^\* SEARCH\b(.*)$/i)
    if (!m) continue
    for (const tok of m[1].trim().split(/\s+/)) {
      if (/^\d+$/.test(tok)) uids.push(Number(tok))
    }
  }
  return uids
}

export interface SelectInfo {
  uidValidity: number | null
  uidNext: number | null
  exists: number | null
}

/** UIDVALIDITY / UIDNEXT / EXISTS from a SELECT response. */
export function parseSelect(lines: string[]): SelectInfo {
  const info: SelectInfo = { uidValidity: null, uidNext: null, exists: null }
  for (const line of lines) {
    let m = line.match(/\[UIDVALIDITY (\d+)\]/i)
    if (m) info.uidValidity = Number(m[1])
    m = line.match(/\[UIDNEXT (\d+)\]/i)
    if (m) info.uidNext = Number(m[1])
    m = line.match(/^\* (\d+) EXISTS/i)
    if (m) info.exists = Number(m[1])
  }
  return info
}

/** Newer-than-cursor UIDs, oldest-first, capped to the newest `batch` so a
 *  first poll of a huge mailbox imports a bounded, recent slice (and advances
 *  the cursor past it). */
export function selectNewUids(uids: number[], lastUid: number, batch: number): number[] {
  const fresh = uids.filter((u) => u > lastUid).sort((a, b) => a - b)
  return fresh.length > batch ? fresh.slice(fresh.length - batch) : fresh
}

function quote(s: string): string {
  return '"' + s.replace(/([\\"])/g, '\\$1') + '"'
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`IMAP ${what} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

export interface ImapConnectOptions {
  host: string
  port: number
  timeoutMs?: number
}

/** Thin socket driver over Deno.connectTls. Not unit-tested (needs a real
 *  socket); its parsing pieces above are. Always `close()` in a finally. */
export class ImapClient {
  #host: string
  #port: number
  #timeout: number
  #conn: (ByteSource & { write(p: Uint8Array): Promise<number>; close(): void }) | null = null
  #reader: ImapReader | null = null
  #seq = 0

  constructor(opts: ImapConnectOptions) {
    this.#host = opts.host
    this.#port = opts.port
    this.#timeout = opts.timeoutMs ?? 20000
  }

  #tag(): string {
    this.#seq += 1
    return 'a' + String(this.#seq).padStart(4, '0')
  }

  async #send(line: string): Promise<void> {
    if (!this.#conn) throw new Error('not connected')
    await this.#conn.write(encoder.encode(line + '\r\n'))
  }

  async connect(): Promise<void> {
    this.#conn = await withTimeout(
      Deno.connectTls({ hostname: this.#host, port: this.#port }),
      this.#timeout,
      'connect',
    ) as unknown as ByteSource & { write(p: Uint8Array): Promise<number>; close(): void }
    this.#reader = new ImapReader(this.#conn)
    // Consume the server greeting (`* OK …`).
    await withTimeout(this.#reader.readLine(), this.#timeout, 'greeting')
  }

  async login(username: string, password: string): Promise<void> {
    const tag = this.#tag()
    await this.#send(`${tag} LOGIN ${quote(username)} ${quote(password)}`)
    const res = await withTimeout(readLineResponse(this.#reader!, tag), this.#timeout, 'login')
    if (!res.ok) throw new Error('IMAP login failed (check username / app password)')
  }

  async select(folder: string): Promise<SelectInfo> {
    const tag = this.#tag()
    await this.#send(`${tag} SELECT ${quote(folder)}`)
    const res = await withTimeout(readLineResponse(this.#reader!, tag), this.#timeout, 'select')
    if (!res.ok) throw new Error(`IMAP SELECT ${folder} failed`)
    return parseSelect(res.lines)
  }

  /** UIDs strictly greater than `lastUid` (server-side `UID SEARCH UID n:*`). */
  async searchNewUids(lastUid: number): Promise<number[]> {
    const tag = this.#tag()
    const from = Math.max(1, lastUid + 1)
    await this.#send(`${tag} UID SEARCH UID ${from}:*`)
    const res = await withTimeout(readLineResponse(this.#reader!, tag), this.#timeout, 'search')
    if (!res.ok) throw new Error('IMAP SEARCH failed')
    // `n:*` always returns at least the highest message even when none are newer,
    // so filter to strictly-greater here.
    return parseSearchUids(res.lines).filter((u) => u > lastUid)
  }

  async fetchBodies(uids: number[]): Promise<FetchedMessage[]> {
    if (!uids.length) return []
    const tag = this.#tag()
    await this.#send(`${tag} UID FETCH ${uids.join(',')} (UID BODY.PEEK[])`)
    return await withTimeout(readFetchMessages(this.#reader!, tag), this.#timeout, 'fetch')
  }

  async markSeen(uids: number[]): Promise<void> {
    if (!uids.length) return
    const tag = this.#tag()
    await this.#send(`${tag} UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Seen)`)
    await withTimeout(readLineResponse(this.#reader!, tag), this.#timeout, 'store')
  }

  async logout(): Promise<void> {
    try {
      const tag = this.#tag()
      await this.#send(`${tag} LOGOUT`)
      await withTimeout(readLineResponse(this.#reader!, tag), 3000, 'logout')
    } catch {
      // best effort
    }
  }

  close(): void {
    try {
      this.#conn?.close()
    } catch {
      // already closed
    }
    this.#conn = null
    this.#reader = null
  }
}
