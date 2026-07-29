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
import { parseEmailMessage } from '../_shared/imap.ts'
import { ImapClient, withTimeout } from '../_shared/imap_client.ts'

// deno-lint-ignore no-explicit-any
type DB = any

const ACCOUNT_BUDGET = 20 // accounts polled per tick
const MAX_PER_ACCOUNT = 25 // new messages ingested per account per tick
const INITIAL_BACKFILL = 10 // on a brand-new inbox, only grab the most recent N
const MAX_BODY = 50_000
const SOCKET_TIMEOUT_MS = 20_000

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
