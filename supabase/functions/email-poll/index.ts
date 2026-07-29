// Supabase Edge Function: `email-poll` (PUBLIC — verify_jwt=false, gated by the
// same DB-stored cron secret the scheduler/event-dispatch use). Ticked every
// minute by pg_cron. It PULLS new mail from each registered IMAP inbox
// (`email_accounts`, 0102) into the unified inbox (`inbox_messages`,
// source='email') — which already emits `message.received` (0064), so a Listener
// routes it exactly like a webhook.
//
// IMAP framing (command tags + {N} literals) is handled here over a Deno TLS
// socket; the RFC822 → normalized-message parsing is the pure, unit-tested
// _shared/imap.ts. Each account is polled at most once per its
// poll_interval_minutes; per-tick and per-account caps bound the work, and any
// failure is recorded on the account's `last_error` (surfaced in the UI) instead
// of throwing the whole tick.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { parseEmailMessage, parseFetchUid, parseSearchUids } from '../_shared/imap.ts'

// deno-lint-ignore no-explicit-any
type DB = any

const ACCOUNT_BUDGET = 20 // accounts polled per tick
const MAX_PER_ACCOUNT = 25 // new messages ingested per account per tick
const INITIAL_BACKFILL = 10 // on a brand-new inbox, only grab the most recent N
const MAX_BODY = 50_000
const SOCKET_TIMEOUT_MS = 20_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
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

// Minimal line/literal-aware IMAP client over a Deno TCP/TLS connection.
class ImapClient {
  private conn: Deno.Conn
  private pending = new Uint8Array(0)
  private tag = 0
  private enc = new TextEncoder()
  // latin1: preserve bytes 1:1 so literals (incl. base64/8-bit) survive intact;
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

  // Run a command; collect untagged (`*`) lines until the tagged terminator.
  // Any `{N}` literal on an untagged line is read as N raw bytes and appended to
  // that line's captured text (so a BODY[] literal comes back whole).
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
        // consume the rest of this response line (e.g. the closing ")")
        line += await this.readLine()
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

  // UIDs strictly greater than `sinceUid` (uses server-side search, then filters
  // to be safe against the `n:*` "always returns the last message" quirk).
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
      const brace = line.indexOf('{')
      // The literal was spliced in right after the "{N}" marker was stripped;
      // everything from the first content char after "BODY[]" is the message.
      const bodyStart = line.search(/BODY(?:\.PEEK)?\[\]/i)
      let raw = ''
      if (bodyStart !== -1) {
        // after "BODY[]" the "{N}" marker was removed and the literal spliced in.
        raw = line.slice(line.indexOf(']', bodyStart) + 1)
        // drop a leading space and a trailing ")" from the FETCH wrapper
        raw = raw.replace(/^\s/, '').replace(/\)\s*$/, '')
      } else if (brace !== -1) {
        raw = line.slice(brace)
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

interface Account {
  id: string
  label: string
  host: string
  port: number
  secure: boolean
  username: string
  folder: string
  last_seen_uid: number
  poll_interval_minutes: number
  visibility: string
  owner_id: string | null
  active: boolean
  last_checked_at: string | null
}

async function pollAccount(db: DB, acct: Account): Promise<{ ingested: number }> {
  const password = await db.rpc('read_email_account_secret', { p_account_id: acct.id })
  const secret: string | null = password.data ?? null
  if (!secret) throw new Error('password not found in vault')

  const client = await withTimeout(
    ImapClient.connect(acct.host, acct.port, acct.secure),
    SOCKET_TIMEOUT_MS,
    'connect',
  )
  try {
    await withTimeout(client.login(acct.username, secret), SOCKET_TIMEOUT_MS, 'login')
    await withTimeout(client.select(acct.folder || 'INBOX'), SOCKET_TIMEOUT_MS, 'select')
    let uids = await withTimeout(client.searchNewUids(acct.last_seen_uid), SOCKET_TIMEOUT_MS, 'search')

    // Brand-new inbox: don't backfill the entire mailbox — take the most recent N.
    if (acct.last_seen_uid === 0 && uids.length > INITIAL_BACKFILL) {
      uids = uids.slice(-INITIAL_BACKFILL)
    }
    uids = uids.slice(0, MAX_PER_ACCOUNT)

    let ingested = 0
    let highest = acct.last_seen_uid
    for (const uid of uids) {
      const fetched = await withTimeout(client.fetchRaw(uid), SOCKET_TIMEOUT_MS, 'fetch')
      highest = Math.max(highest, uid)
      if (!fetched || !fetched.raw.trim()) continue
      const msg = parseEmailMessage(fetched.raw)
      const externalId = msg.messageId || `${acct.id}:${uid}`
      const { error } = await db.from('inbox_messages').upsert(
        {
          owner_id: acct.owner_id,
          source: 'email',
          external_id: externalId,
          from_address: msg.from || '(unknown)',
          from_name: msg.fromName || null,
          to_address: msg.to || acct.username,
          subject: msg.subject || '(no subject)',
          body_text: msg.text.slice(0, MAX_BODY),
          visibility: acct.visibility,
          raw: { provider: 'imap', account_id: acct.id, uid, date: msg.date },
        },
        { onConflict: 'source,external_id', ignoreDuplicates: true },
      )
      if (!error) ingested++
    }

    await client.logout()
    await db
      .from('email_accounts')
      .update({
        last_seen_uid: highest,
        last_checked_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', acct.id)
    return { ingested }
  } finally {
    client.close()
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const secret = req.headers.get('x-cron-secret') ?? ''
  const { data: cfg } = await db.from('cron_config').select('secret').limit(1).maybeSingle()
  if (!cfg || secret !== cfg.secret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  const { data: accounts } = await db
    .from('email_accounts')
    .select(
      'id, label, host, port, secure, username, folder, last_seen_uid, poll_interval_minutes, visibility, owner_id, active, last_checked_at',
    )
    .eq('active', true)
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(ACCOUNT_BUDGET)

  const now = Date.now()
  const due = (accounts ?? []).filter((a: Account) => {
    if (!a.last_checked_at) return true
    const elapsedMin = (now - new Date(a.last_checked_at).getTime()) / 60000
    return elapsedMin >= a.poll_interval_minutes
  })

  let polled = 0
  let ingested = 0
  const errors: Array<{ account: string; error: string }> = []
  for (const acct of due) {
    polled++
    try {
      const res = await pollAccount(db, acct)
      ingested += res.ingested
    } catch (e) {
      const message = e instanceof Error ? e.message : 'poll failed'
      errors.push({ account: acct.label || acct.username, error: message })
      await db
        .from('email_accounts')
        .update({ last_checked_at: new Date().toISOString(), last_error: message.slice(0, 500) })
        .eq('id', acct.id)
      await db.from('activity_log').insert({
        type: 'email.poll_error',
        summary: `IMAP poll failed for ${acct.label || acct.username}: ${message}`.slice(0, 300),
        detail: { account_id: acct.id },
        actor_id: acct.owner_id,
      })
    }
  }

  return new Response(JSON.stringify({ accounts: due.length, polled, ingested, errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
