// Shared executor for `builtin` tools — tools run in-function (as opposed to
// `http` tools that POST to a URL, or `web` tools that switch on OpenRouter's
// web-search plugin). Centralized here so ALL THREE agent loops (chat,
// webhook, scheduler) can run them: the "morning agent emails me" flow runs
// through the scheduler, so this is load-bearing, not a refactor nicety.
//
// Builtins: search_documents (RAG over the workspace knowledge base), send_email,
// check_email, the user-table tools (list_tables / query_table / add_table_row /
// create_table — the "Tables" feature), and the team-vault tools (list_secrets /
// get_secret). send_email and get_secret are exfiltration-capable — send_email
// enforces a recipient allowlist + rate limit and get_secret returns a raw
// credential, so both log every use. The table and vault builtins run with the
// service role, so they re-enforce the private/workspace access rule in code.
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
    case 'list_tables':
      return listTables(db, userId)
    case 'query_table':
      return queryTable(db, input, userId)
    case 'add_table_row':
      return addTableRow(db, input, userId)
    case 'create_table':
      return createTable(db, input, userId)
    case 'list_secrets':
      return listSecrets(db, userId)
    case 'get_secret':
      return getSecret(db, input, userId)
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

// --- Team secrets vault ------------------------------------------------------
// Builtins run with the service role (RLS bypassed), so these re-enforce the
// private/workspace share rule in code via the security-definer RPCs. `get_secret`
// returns a raw credential into the conversation — exfiltration-capable, like
// send_email — so every read is written to the activity log.

async function listSecrets(db: DB | null, userId: string | null): Promise<string> {
  if (!db) return 'The team vault is unavailable.'
  const { data } = await db
    .from('vault_secrets')
    .select('name, description, scope, owner_id')
    .order('name', { ascending: true })
  const rows = (data ?? []) as Array<{ name: string; description: string; scope: string; owner_id: string | null }>
  // Re-enforce the share rule: workspace secrets to anyone, private only to its owner.
  const visible = rows.filter((r) => r.scope === 'workspace' || r.owner_id === userId)
  if (!visible.length) return 'The team vault has no secrets you can access.'
  return visible
    .map((r) => `- ${r.name}${r.description ? ` — ${r.description}` : ''}`)
    .join('\n')
}

async function getSecret(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db) return 'The team vault is unavailable.'
  const name = String(input?.name ?? '').trim()
  if (!name) return 'No secret name was provided.'
  const { data, error } = await db.rpc('read_vault_secret', { p_name: name, p_user_id: userId })
  if (error) return `Could not read the secret: ${error.message}`
  if (!data || typeof data !== 'string') {
    return `No secret named "${name}" is available to you. Use list_secrets to see what exists.`
  }
  await logActivity(db, 'secret.read', `Fetched secret: ${name}`, { name }, userId)
  return data
}

// --- User tables ("Tables" feature) -----------------------------------------
// Builtins run with the service role (RLS bypassed), so these enforce the same
// private/workspace access in code: a table is reachable when the caller owns it
// OR it's shared workspace-wide. Writes follow the same rule (workspace tables
// are collaborative). Structural creation goes through the create_user_table RPC.

interface UTColumn {
  key: string
  label: string
  type: string
}
interface UTRow {
  id: string
  name: string
  physical_name: string
  owner_id: string
  columns: UTColumn[]
  visibility: string
}

function slugifyKey(label: string): string {
  const s = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!s) return 'col'
  return /^[a-z]/.test(s) ? s : `c_${s}`
}

// Load the tables this caller may use (owned or workspace-shared).
async function accessibleTables(db: DB, userId: string | null): Promise<UTRow[]> {
  if (!userId) return []
  const { data } = await db
    .from('user_tables')
    .select('id, name, physical_name, owner_id, columns, visibility')
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
  return (data ?? []) as UTRow[]
}

function findTable(tables: UTRow[], ref: string): UTRow | undefined {
  const r = ref.trim().toLowerCase()
  return tables.find((t) => t.id === ref || t.name.trim().toLowerCase() === r)
}

async function listTables(db: DB | null, userId: string | null): Promise<string> {
  if (!db || !userId) return 'Tables are unavailable.'
  const tables = await accessibleTables(db, userId)
  if (!tables.length) return 'There are no data tables yet. Use create_table to make one.'
  return tables
    .map((t) => {
      const cols = (t.columns ?? []).map((c) => `${c.key} (${c.type})`).join(', ') || 'no columns yet'
      const own = t.owner_id === userId ? 'yours' : 'shared'
      return `• ${t.name} [${t.visibility}, ${own}] — columns: ${cols}`
    })
    .join('\n')
}

async function queryTable(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Tables are unavailable.'
  const ref = String(input?.table ?? '').trim()
  if (!ref) return 'Which table? Pass a table name.'
  const t = findTable(await accessibleTables(db, userId), ref)
  if (!t) return `No table named "${ref}" that you can access.`

  let limit = Number(input?.limit ?? 50)
  if (!Number.isFinite(limit) || limit <= 0) limit = 50
  limit = Math.min(Math.trunc(limit), 200)

  // deno-lint-ignore no-explicit-any
  let q: any = db.from(t.physical_name).select('*').limit(limit)
  const filters = (input?.filters ?? null) as Record<string, unknown> | null
  if (filters && typeof filters === 'object') {
    const allowed = new Set((t.columns ?? []).map((c) => c.key).concat(['id', 'owner_id']))
    for (const [k, v] of Object.entries(filters)) {
      if (allowed.has(k)) q = q.eq(k, v)
    }
  }
  const { data, error } = await q
  if (error) return `Could not read "${t.name}": ${error.message}`
  if (!data || !data.length) return `"${t.name}" has no matching rows.`
  return `Rows from "${t.name}" (${data.length}):\n${JSON.stringify(data, null, 2)}`
}

async function addTableRow(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Tables are unavailable.'
  const ref = String(input?.table ?? '').trim()
  if (!ref) return 'Which table? Pass a table name.'
  const t = findTable(await accessibleTables(db, userId), ref)
  if (!t) return `No table named "${ref}" that you can access.`

  const values = (input?.values ?? null) as Record<string, unknown> | null
  if (!values || typeof values !== 'object') return 'Pass the row data as a "values" object.'
  const allowed = new Set((t.columns ?? []).map((c) => c.key))
  const row: Record<string, unknown> = { owner_id: userId }
  const skipped: string[] = []
  for (const [k, v] of Object.entries(values)) {
    if (allowed.has(k)) row[k] = v
    else skipped.push(k)
  }
  const { error } = await db.from(t.physical_name).insert(row)
  if (error) return `Could not add the row: ${error.message}`
  const note = skipped.length ? ` (ignored unknown columns: ${skipped.join(', ')})` : ''
  return `Added a row to "${t.name}".${note}`
}

async function createTable(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Tables are unavailable.'
  const name = String(input?.name ?? '').trim()
  if (!name) return 'A table name is required.'
  const visibility = input?.visibility === 'workspace' ? 'workspace' : 'private'
  const rawCols = Array.isArray(input?.columns) ? (input.columns as Record<string, unknown>[]) : []
  const columns = rawCols.map((c) => {
    const label = String(c?.label ?? c?.name ?? 'Field')
    return { key: slugifyKey(label), label, type: String(c?.type ?? 'text') }
  })
  const { data, error } = await db.rpc('create_user_table', {
    p_name: name,
    p_columns: columns,
    p_visibility: visibility,
    p_owner: userId,
  })
  if (error) return `Could not create the table: ${error.message}`
  await logActivity(db, 'table.created', `Created table "${name}"`, { name, visibility }, userId)
  const created = (Array.isArray(data) ? data[0] : data) as { name?: string } | null
  return `Created table "${created?.name ?? name}" (${visibility}). It's now in Tables and you can add rows to it.`
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
