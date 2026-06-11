// Shared executor for `builtin` tools — tools run in-function (as opposed to
// `http` tools that POST to a URL, or `web` tools that switch on Anthropic's
// server-side search/fetch). Centralized here so ALL THREE agent loops (chat,
// webhook, scheduler) can run them: the "morning agent emails me" flow runs
// through the scheduler, so this is load-bearing, not a refactor nicety.
//
// Builtins: search_documents (RAG over the workspace knowledge base), send_email,
// check_email. send_email is exfiltration-capable — it enforces an optional
// recipient allowlist, a per-hour rate limit, and logs every send.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

type DB = ReturnType<typeof createClient>

const EMAIL_NOT_CONFIGURED = "Email isn't configured. An admin can set it up in Settings → Email."
const SEND_LIMIT_PER_HOUR = 20
const MAX_BODY_PREVIEW = 500

export async function runBuiltin(
  db: DB | null,
  name: string,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  switch (name) {
    case 'search_documents':
      return searchDocuments(db, input, userId)
    case 'send_email':
      return sendEmail(db, input, userId)
    case 'check_email':
      return checkEmail(db, input)
    default:
      return `Unknown builtin: ${name}`
  }
}

async function logActivity(
  db: DB,
  type: string,
  summary: string,
  detail: Record<string, unknown>,
  actorId: string | null,
) {
  try {
    await db.from('activity_log').insert({ type, summary, detail, actor_id: actorId })
  } catch {
    // best-effort
  }
}

// search_documents: embed the query with the free in-edge gte-small model and
// run a pgvector match over the workspace's shared knowledge plus the caller's
// own private documents (RLS-scoped via match_document_chunks, service-role only).
async function searchDocuments(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Document search is unavailable.'
  try {
    // deno-lint-ignore no-explicit-any
    const model = new (globalThis as any).Supabase.ai.Session('gte-small')
    const embedding = await model.run(String(input?.query ?? ''), { mean_pool: true, normalize: true })
    const { data } = await db.rpc('match_document_chunks', {
      query_embedding: embedding,
      match_owner: userId,
      match_count: 6,
    })
    if (!data || data.length === 0) return 'No matching passages found in the documents.'
    return (data as Array<{ content: string; document_name?: string }>)
      .map((d, i) => `[${i + 1}] (${d.document_name ?? 'document'}) ${d.content}`)
      .join('\n\n---\n\n')
  } catch (err) {
    return `Document search failed: ${err instanceof Error ? err.message : 'error'}`
  }
}

// Exact address ('alice@x.com') or '@domain.com' suffix matches.
function recipientAllowed(to: string, allowed: string[]): boolean {
  const addr = to.toLowerCase()
  return allowed.some((a) => {
    const rule = (a ?? '').trim().toLowerCase()
    if (!rule) return false
    return rule.startsWith('@') ? addr.endsWith(rule) : addr === rule
  })
}

async function sendViaProvider(
  provider: string,
  key: string,
  from: string,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; status: number; detail: string }> {
  if (provider === 'postmark') {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': key,
      },
      body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: body, MessageStream: 'outbound' }),
    })
    return { ok: res.ok, status: res.status, detail: (await res.text()).slice(0, 500) }
  }
  // resend
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text: body }),
  })
  return { ok: res.ok, status: res.status, detail: (await res.text()).slice(0, 500) }
}

async function sendEmail(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db) return EMAIL_NOT_CONFIGURED
  const to = String(input?.to ?? '').trim()
  const subject = String(input?.subject ?? '')
  const body = String(input?.body ?? '')
  if (!to) return 'No recipient address was provided.'

  // Service-role read bypasses RLS; the row holds only non-secret config.
  const { data: integ } = await db
    .from('integrations')
    .select('provider, from_address, allowed_recipients')
    .eq('kind', 'email')
    .maybeSingle()
  if (!integ) return EMAIL_NOT_CONFIGURED

  const allowed = (integ.allowed_recipients ?? null) as string[] | null
  if (allowed && allowed.length && !recipientAllowed(to, allowed)) {
    return `Can't email ${to}: this workspace only allows sending to ${allowed.join(', ')}.`
  }

  // Rate limit: max sends per rolling hour across the workspace.
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const { count } = await db
    .from('activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'email.sent')
    .gte('created_at', since)
  if ((count ?? 0) >= SEND_LIMIT_PER_HOUR) {
    return `Email rate limit reached (${SEND_LIMIT_PER_HOUR} per hour). Try again later.`
  }

  // Decrypt the provider key from Vault (service-role-only RPC).
  const { data: key } = await db.rpc('read_email_secret')
  if (!key || typeof key !== 'string') {
    return 'Email is configured but its API key could not be read. An admin may need to re-save it in Settings → Email.'
  }

  try {
    const sent = await sendViaProvider(integ.provider as string, key, integ.from_address as string, to, subject, body)
    if (!sent.ok) {
      await logActivity(db, 'email.error', `Email to ${to} failed (${sent.status})`, { to, subject, status: sent.status }, userId)
      return `The email provider rejected the message (HTTP ${sent.status}). ${sent.detail}`
    }
  } catch (err) {
    return `Failed to send email: ${err instanceof Error ? err.message : 'error'}`
  }

  await logActivity(db, 'email.sent', `Emailed ${to}: ${subject || '(no subject)'}`, { to, subject }, userId)
  return `Email sent to ${to}.`
}

async function checkEmail(db: DB | null, input: Record<string, unknown>): Promise<string> {
  if (!db) return EMAIL_NOT_CONFIGURED
  const { data: integ } = await db.from('integrations').select('id').eq('kind', 'email').maybeSingle()
  if (!integ) return EMAIL_NOT_CONFIGURED

  const unreadOnly = input?.unread_only !== false // default true
  const markRead = input?.mark_read === true
  let limit = Number(input?.limit ?? 10)
  if (!Number.isFinite(limit) || limit <= 0) limit = 10
  limit = Math.min(Math.trunc(limit), 25)

  let q = db
    .from('inbox_messages')
    .select('id, from_address, subject, body_text, received_at, read_at')
    .order('received_at', { ascending: false })
    .limit(limit)
  if (unreadOnly) q = q.is('read_at', null)
  const { data: msgs } = await q
  if (!msgs || msgs.length === 0) {
    return unreadOnly ? 'No unread email in the workspace inbox.' : 'The workspace inbox is empty.'
  }

  if (markRead) {
    const ids = (msgs as Array<{ id: string; read_at: string | null }>)
      .filter((m) => !m.read_at)
      .map((m) => m.id)
    if (ids.length) await db.from('inbox_messages').update({ read_at: new Date().toISOString() }).in('id', ids)
  }

  return (msgs as Array<{ from_address: string; subject: string; body_text: string; received_at: string }>)
    .map((m, i) => {
      const when = new Date(m.received_at).toISOString().slice(0, 16).replace('T', ' ')
      const preview = (m.body_text ?? '').slice(0, MAX_BODY_PREVIEW)
      return `[${i + 1}] From: ${m.from_address}\nSubject: ${m.subject || '(no subject)'}\nDate: ${when} UTC\n${preview}`
    })
    .join('\n\n---\n\n')
}
