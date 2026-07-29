// Minimal line/literal-aware IMAP client over a Deno TCP/TLS socket, shared by
// the `email-poll` (cron pull) and `imap-test` (connection check) functions.
//
// IMAP framing lives here (command tags, {N} literals); RFC822 → normalized
// message parsing is the pure, unit-tested _shared/imap.ts. Kept out of that pure
// module on purpose — this half does real socket I/O and can't be unit-tested the
// same way.
import { parseFetchUid, parseSearchUids } from './imap.ts'

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then((v) => {
      clearTimeout(t)
      resolve(v)
    }).catch((e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

export class ImapClient {
  private conn: Deno.Conn
  private pending = new Uint8Array(0)
  private tag = 0
  private enc = new TextEncoder()
  // latin1: preserve bytes 1:1 so literals (incl. base64 / 8-bit) survive intact;
  // _shared/imap.ts re-decodes per the part's charset.
  private dec = new TextDecoder('latin1')

  constructor(conn: Deno.Conn) {
    this.conn = conn
  }

  static async connect(host: string, port: number, secure: boolean): Promise<ImapClient> {
    const conn = secure
      ? await Deno.connectTls({ hostname: host, port })
      : await Deno.connect({ hostname: host, port })
    const client = new ImapClient(conn)
    await client.readLine() // server greeting (* OK ...)
    return client
  }

  private async fill(): Promise<void> {
    const chunk = new Uint8Array(65536)
    const n = await this.conn.read(chunk)
    if (n === null) throw new Error('connection closed by server')
    const merged = new Uint8Array(this.pending.length + n)
    merged.set(this.pending)
    merged.set(chunk.subarray(0, n), this.pending.length)
    this.pending = merged
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const nl = this.pending.indexOf(10) // \n
      if (nl !== -1) {
        const end = nl > 0 && this.pending[nl - 1] === 13 ? nl - 1 : nl // trim \r
        const line = this.dec.decode(this.pending.subarray(0, end))
        this.pending = this.pending.subarray(nl + 1)
        return line
      }
      await this.fill()
    }
  }

  private async readBytes(n: number): Promise<string> {
    while (this.pending.length < n) await this.fill()
    const out = this.dec.decode(this.pending.subarray(0, n))
    this.pending = this.pending.subarray(n)
    return out
  }

  // Run a command; collect untagged (`*`) lines until the tagged terminator. Any
  // `{N}` literal on an untagged line is read as N raw bytes and appended to that
  // line's captured text (so a BODY[] literal comes back whole).
  private async command(raw: string): Promise<{ ok: boolean; status: string; untagged: string[] }> {
    const tag = `a${++this.tag}`
    await this.conn.write(this.enc.encode(`${tag} ${raw}\r\n`))
    const untagged: string[] = []
    for (;;) {
      let line = await this.readLine()
      const lit = line.match(/\{(\d+)\}$/)
      if (lit) {
        const size = Number(lit[1])
        const data = await this.readBytes(size)
        line = line.slice(0, line.length - lit[0].length) + data
        line += await this.readLine() // consume the rest of this response line
        untagged.push(line)
        continue
      }
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1).trim()
        return { ok: /^OK\b/i.test(status), status, untagged }
      }
      if (line.startsWith('*')) untagged.push(line)
    }
  }

  async login(user: string, pass: string): Promise<void> {
    const q = (s: string) => '"' + s.replace(/([\\"])/g, '\\$1') + '"'
    const r = await this.command(`LOGIN ${q(user)} ${q(pass)}`)
    if (!r.ok) throw new Error(`LOGIN failed: ${r.status}`)
  }

  async select(folder: string): Promise<void> {
    const r = await this.command(`SELECT "${folder.replace(/"/g, '')}"`)
    if (!r.ok) throw new Error(`SELECT ${folder} failed: ${r.status}`)
  }

  // SELECT and return the mailbox's message count (the `* N EXISTS` line) — used
  // by the test action to prove login + folder access in one round-trip.
  async selectInfo(folder: string): Promise<{ exists: number }> {
    const r = await this.command(`SELECT "${folder.replace(/"/g, '')}"`)
    if (!r.ok) throw new Error(`SELECT ${folder} failed: ${r.status}`)
    let exists = 0
    for (const line of r.untagged) {
      const m = line.match(/^\*\s+(\d+)\s+EXISTS\b/i)
      if (m) exists = Number(m[1])
    }
    return { exists }
  }

  // UIDs strictly greater than `sinceUid` (server-side search, then filtered to be
  // safe against the `n:*` "always returns the last message" quirk).
  async searchNewUids(sinceUid: number): Promise<number[]> {
    const query = sinceUid > 0 ? `UID SEARCH UID ${sinceUid + 1}:*` : 'UID SEARCH ALL'
    const r = await this.command(query)
    if (!r.ok) throw new Error(`SEARCH failed: ${r.status}`)
    const uids = parseSearchUids(r.untagged.join('\n')).filter((u) => u > sinceUid)
    return [...new Set(uids)].sort((a, b) => a - b)
  }

  // Fetch one message's raw RFC822 (peek — does not set \Seen).
  async fetchRaw(uid: number): Promise<{ uid: number; raw: string } | null> {
    const r = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`)
    if (!r.ok) return null
    for (const line of r.untagged) {
      if (!/FETCH/i.test(line)) continue
      const fetchedUid = parseFetchUid(line) ?? uid
      const bodyStart = line.search(/BODY(?:\.PEEK)?\[\]/i)
      let raw = ''
      if (bodyStart !== -1) {
        raw = line.slice(line.indexOf(']', bodyStart) + 1)
        raw = raw.replace(/^\s/, '').replace(/\)\s*$/, '')
      }
      return { uid: fetchedUid, raw }
    }
    return null
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT')
    } catch {
      // ignore
    }
  }

  close(): void {
    try {
      this.conn.close()
    } catch {
      // already closed
    }
  }
}
