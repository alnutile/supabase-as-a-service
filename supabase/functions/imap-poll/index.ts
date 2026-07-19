// Supabase Edge Function: `imap-poll` (PUBLIC — verify_jwt=false).
//
// The first PULL connector into the unified inbox. Two ways in:
//   1. Cron mode — pg_cron ticks this every minute with the `x-cron-secret`
//      (same gate as the scheduler); it claims every imap_accounts row whose
//      next_poll_at is due and polls it.
//   2. Poll-now mode — the Settings UI (or any owner) calls it with a Supabase
//      session JWT / mcp_tokens bearer and `{account_id}`; it polls just that
//      account immediately and returns a human-readable result (doubles as a
//      "Test connection" button). Owner-checked in code.
//
// Each poll: connect over TLS, LOGIN, SELECT the folder, UID SEARCH for mail
// newer than the account's cursor, UID FETCH a bounded batch, parse each with
// postal-mime, and insert into `inbox_messages` (dedup on (source, external_id)).
// Passwords are read from Vault via the service-role-only read_imap_secret RPC.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import PostalMime from 'npm:postal-mime@2.7.5'
import { ImapClient, selectNewUids } from '../_shared/imap.ts'
import { parseBearer, resolveApiUser } from '../_shared/apiauth.ts'

const BATCH = 25 // max messages ingested per account per poll (bounds first runs)
const MAX_BODY = 50_000
const MAX_ACCOUNTS_PER_TICK = 10

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function stripHtml(html: unknown): string {
  if (typeof html !== 'string') return ''
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

interface ParsedMail {
  from?: { address?: string; name?: string }
  to?: { address?: string }[]
  subject?: string
  text?: string
  html?: string
  messageId?: string
  date?: string
}

interface ImapAccount {
  id: string
  owner_id: string
  label: string
  host: string
  port: number
  username: string
  folder: string
  visibility: 'private' | 'workspace'
  mark_seen: boolean
  poll_interval_minutes: number
  last_uid: number
  uid_validity: number | null
}

interface PollOutcome {
  ok: boolean
  imported: number
  message: string
}

// deno-lint-ignore no-explicit-any
async function pollAccount(db: any, account: ImapAccount): Promise<PollOutcome> {
  const { data: password, error: secretErr } = await db.rpc('read_imap_secret', { p_account_id: account.id })
  if (secretErr || !password) {
    return { ok: false, imported: 0, message: 'Could not read the stored password from Vault.' }
  }

  const client = new ImapClient({ host: account.host, port: account.port })
  let imported = 0
  let maxUid = account.last_uid
  let newValidity = account.uid_validity
  try {
    await client.connect()
    await client.login(account.username, password)
    const box = await client.select(account.folder || 'INBOX')

    // If the server's UIDVALIDITY changed, prior UIDs are meaningless — start over.
    let effectiveLastUid = account.last_uid
    if (box.uidValidity != null && account.uid_validity != null && box.uidValidity !== account.uid_validity) {
      effectiveLastUid = 0
    }
    if (box.uidValidity != null) newValidity = box.uidValidity
    maxUid = effectiveLastUid

    const allNew = await client.searchNewUids(effectiveLastUid)
    const toFetch = selectNewUids(allNew, effectiveLastUid, BATCH)
    const messages = await client.fetchBodies(toFetch)

    for (const msg of messages) {
      let parsed: ParsedMail
      try {
        parsed = (await new PostalMime().parse(msg.body)) as unknown as ParsedMail
      } catch {
        // Unparseable MIME still advances the cursor; store the raw text.
        parsed = { text: new TextDecoder('latin1').decode(msg.body).slice(0, MAX_BODY) }
      }
      const messageId = typeof parsed.messageId === 'string' && parsed.messageId.trim()
        ? parsed.messageId.trim()
        : `imap-${account.id}-${msg.uid}`
      const bodyText = (parsed.text && parsed.text.trim() ? parsed.text : stripHtml(parsed.html)).slice(0, MAX_BODY)
      const receivedAt = parsed.date && !Number.isNaN(Date.parse(parsed.date)) ? parsed.date : undefined

      const { error: insErr } = await db.from('inbox_messages').insert({
        owner_id: account.owner_id,
        source: 'email',
        external_id: messageId,
        from_name: parsed.from?.name ?? '',
        from_address: parsed.from?.address || '(unknown)',
        to_address: parsed.to?.[0]?.address ?? null,
        subject: parsed.subject ?? '',
        body_text: bodyText,
        visibility: account.visibility,
        received_at: receivedAt,
        raw: { provider: 'imap', account_id: account.id, uid: msg.uid, folder: account.folder, message_id: messageId },
      })
      if (insErr) {
        // 23505 = duplicate (source, external_id): a benign re-delivery.
        if (insErr.code !== '23505') throw new Error(insErr.message)
      } else {
        imported += 1
      }
      if (msg.uid > maxUid) maxUid = msg.uid
    }

    if (account.mark_seen && toFetch.length) {
      await client.markSeen(toFetch)
    }
    await client.logout()
    return { ok: true, imported, message: imported ? `Imported ${imported} new message${imported === 1 ? '' : 's'}.` : 'No new mail.' }
  } catch (err) {
    return { ok: false, imported, message: err instanceof Error ? err.message : 'IMAP poll failed' }
  } finally {
    client.close()
    // Persist the cursor + status regardless of outcome (service role bypasses RLS).
    const now = new Date()
    const next = new Date(now.getTime() + Math.max(1, account.poll_interval_minutes) * 60_000).toISOString()
    await db.from('imap_accounts').update({
      last_uid: maxUid,
      uid_validity: newValidity,
      last_polled_at: now.toISOString(),
      next_poll_at: next,
    }).eq('id', account.id)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)
  const db = createClient(supabaseUrl, serviceKey)

  const cronSecret = req.headers.get('x-cron-secret') ?? ''
  const { data: cfg } = await db.from('cron_config').select('secret').limit(1).maybeSingle()
  const isCron = cfg && cronSecret && cronSecret === cfg.secret

  // ---- Poll-now / test mode: an authenticated owner polls one account. --------
  if (!isCron) {
    const userId = await resolveApiUser(db, parseBearer(req.headers.get('authorization')))
    if (!userId) return json({ error: 'unauthorized' }, 401)
    let body: Record<string, unknown> = {}
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      // empty body is fine for cron; here we need an account_id
    }
    const accountId = typeof body.account_id === 'string' ? body.account_id : ''
    if (!accountId) return json({ error: 'account_id is required' }, 400)
    const { data: account } = await db
      .from('imap_accounts')
      .select('id, owner_id, label, host, port, username, folder, visibility, mark_seen, poll_interval_minutes, last_uid, uid_validity')
      .eq('id', accountId)
      .maybeSingle()
    if (!account || account.owner_id !== userId) return json({ error: 'not found' }, 404)

    const outcome = await pollAccount(db, account as ImapAccount)
    await db.from('imap_accounts').update({ last_status: outcome.ok ? 'ok' : 'error', last_error: outcome.ok ? null : outcome.message }).eq('id', accountId)
    await db.from('activity_log').insert({
      type: outcome.ok ? 'imap.poll' : 'imap.error',
      summary: `IMAP ${account.label || account.host}: ${outcome.message}`,
      detail: { account_id: accountId, imported: outcome.imported },
      actor_id: userId,
    })
    return json({ ok: outcome.ok, imported: outcome.imported, message: outcome.message })
  }

  // ---- Cron mode: poll every due account. -------------------------------------
  const nowIso = new Date().toISOString()
  const { data: due } = await db
    .from('imap_accounts')
    .select('id, owner_id, label, host, port, username, folder, visibility, mark_seen, poll_interval_minutes, last_uid, uid_validity, next_poll_at')
    .eq('is_active', true)
    .lte('next_poll_at', nowIso)
    .limit(MAX_ACCOUNTS_PER_TICK)

  let polled = 0
  let imported = 0
  for (const account of (due ?? []) as (ImapAccount & { next_poll_at: string })[]) {
    // Claim the row so a slow poll that outlasts the 1-minute tick can't double-fire:
    // push next_poll_at forward now, only if it's still the value we read.
    const provisional = new Date(Date.now() + Math.max(1, account.poll_interval_minutes) * 60_000).toISOString()
    const { data: claimed } = await db
      .from('imap_accounts')
      .update({ next_poll_at: provisional })
      .eq('id', account.id)
      .eq('next_poll_at', account.next_poll_at)
      .select('id')
    if (!claimed?.length) continue

    const outcome = await pollAccount(db, account)
    polled += 1
    imported += outcome.imported
    await db.from('imap_accounts').update({ last_status: outcome.ok ? 'ok' : 'error', last_error: outcome.ok ? null : outcome.message }).eq('id', account.id)
    await db.from('activity_log').insert({
      type: outcome.ok ? 'imap.poll' : 'imap.error',
      summary: `IMAP ${account.label || account.host}: ${outcome.message}`,
      detail: { account_id: account.id, imported: outcome.imported },
      actor_id: account.owner_id,
    })
  }

  return json({ polled, imported })
})
