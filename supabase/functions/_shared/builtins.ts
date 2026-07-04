// Shared executor for `builtin` tools — tools run in-function (as opposed to
// `http` tools that POST to a URL, or `web` tools that switch on OpenRouter's
// web-search plugin). Centralized here so ALL THREE agent loops (chat,
// webhook, scheduler) can run them: the "morning agent emails me" flow runs
// through the scheduler, so this is load-bearing, not a refactor nicety.
//
// Builtins: search_documents (RAG over the workspace knowledge base), send_email,
// check_email, the user-table tools (list_tables / query_table / add_table_row /
// update_table_row / delete_table_row / create_table — the "Tables" feature), the team-vault tools (list_secrets /
// get_secret), and the content-authoring tools (create_artifact / list_collections /
// create_collection / add_to_collection / add_note) — the in-app mirror of the MCP
// server's authoring actions, so the internal AI/agents can push articles, notes, and
// docs into artifacts + collections + the knowledge base (the "ingest GitHub articles
// into a collection we can chat with" flow). send_email and get_secret are
// exfiltration-capable — send_email enforces a recipient allowlist + rate limit and
// get_secret returns a raw credential, so both log every use. The table, vault, and
// authoring builtins run with the service role, so they re-enforce the
// private/workspace access rule in code (owner = caller).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { ingestText } from './knowledge.ts'
import { hostOf, resolveVaultRefs } from './http_tool.ts'
import { fetchLinkMetadata } from './linkmeta.ts'
import { htmlToMarkdown } from './html_markdown.ts'
import {
  createLoop,
  findOrCreateLoopAgent,
  formatRun,
  getRun,
  latestRunForLoop,
  listLoopsText,
  resolveAgent,
  resolveFeedbackTool,
  resolveLoop,
  triggerLoopRun,
} from './loops.ts'

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
    case 'update_table_row':
      return updateTableRow(db, input, userId)
    case 'delete_table_row':
      return deleteTableRow(db, input, userId)
    case 'create_table':
      return createTable(db, input, userId)
    case 'list_secrets':
      return listSecrets(db, userId)
    case 'get_secret':
      return getSecret(db, input, userId)
    case 'create_artifact':
      return createArtifact(db, input, userId)
    case 'list_collections':
      return listCollections(db, userId)
    case 'create_collection':
      return createCollection(db, input, userId)
    case 'add_to_collection':
      return addToCollection(db, input, userId)
    case 'add_note':
      return addNote(db, input, userId)
    case 'start_loop':
      return startLoop(db, input, userId)
    case 'check_loop':
      return checkLoop(db, input, userId)
    case 'list_loops':
      return listLoops(db, userId)
    case 'create_todo':
      return createTodo(db, input, userId)
    case 'list_todos':
      return listTodos(db, input, userId)
    case 'complete_todo':
      return completeTodo(db, input, userId)
    case 'update_todo':
      return updateTodo(db, input, userId)
    case 'add_todo_to_collection':
      return addTodoToCollection(db, input, userId)
    case 'save_link':
      return saveLink(db, input, userId)
    case 'list_links':
      return listLinks(db, input, userId)
    case 'add_link_to_collection':
      return addLinkToCollection(db, input, userId)
    case 'add_table_to_collection':
      return addTableToCollection(db, input, userId)
    case 'http_request':
      return httpRequest(db, input, userId)
    default:
      return `Unknown builtin: ${name}`
  }
}

// http_request: the generic, n8n-style HTTP tool. The MODEL picks the url, so
// the vault rules are strict (requireBinding): a {{vault:name}} reference only
// resolves when that secret's allowed_hosts covers the target host, and
// unbound secrets refuse outright. Without secret references it's a plain
// fetch (same trust level as web_fetch). Each call is activity-logged.
async function httpRequest(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db) return 'http_request is unavailable.'
  const rawUrl = String(input?.url ?? '').trim()
  if (!/^https?:\/\//i.test(rawUrl)) return 'A full http(s) url is required.'
  const host = hostOf(rawUrl)
  if (!host) return 'Invalid url.'

  const givenMethod = String(input?.method ?? '').toUpperCase()
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(givenMethod)
    ? givenMethod
    : input?.body != null
      ? 'POST'
      : 'GET'

  let url: string
  const headers: Record<string, string> = {}
  const usedSecrets = /\{\{\s*vault:/.test(rawUrl + JSON.stringify(input?.headers ?? {}))
  try {
    url = await resolveVaultRefs(db, rawUrl, { host, requireBinding: true })
    for (const [k, v] of Object.entries((input?.headers as Record<string, unknown>) ?? {})) {
      headers[k] = await resolveVaultRefs(db, String(v), { host, requireBinding: true })
    }
  } catch (err) {
    return `Request blocked: ${err instanceof Error ? err.message : 'bad secret reference'}.`
  }

  let body: string | undefined
  if (method !== 'GET' && input?.body != null) {
    if (typeof input.body === 'string') body = input.body
    else {
      body = JSON.stringify(input.body)
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json'
      }
    }
  }

  try {
    const res = await fetch(url, { method, headers, body })
    let text = await res.text()
    // HTML comes back as markdown by default — tag soup wastes the response
    // budget; converting BEFORE the slice keeps far more actual content.
    // Pass format: "raw" for the untouched body (e.g. to scrape attributes).
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(text.slice(0, 200))
    if (input?.format !== 'raw' && isHtml) text = htmlToMarkdown(text)
    text = text.slice(0, 50000)
    await logActivity(
      db,
      'tool.http_request',
      `${method} ${host} (${res.status})`,
      { method, host, status: res.status, used_secrets: usedSecrets },
      userId,
    )
    return text || `(empty response, status ${res.status})`
  } catch (err) {
    return `Request failed: ${err instanceof Error ? err.message : 'error'}`
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

// --- Loops (goal-directed runs) ----------------------------------------------
// Let the in-app assistant spin up a COMPILOT-style loop in one shot — "here's a
// prompt + a rubric, iterate at this budget, then I'll check on it" — and poll it.
// The loop runs in the background (the `loop` edge function streams to loop_runs),
// so start_loop returns immediately with a run id and check_loop reads progress.
// Shares createLoop/triggerLoopRun with the MCP server so both stay in lockstep.

async function startLoop(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Loops are unavailable.'
  const goal = String(input?.goal ?? '').trim()
  if (!goal) return 'A goal is required — the prompt describing what the loop should optimize toward.'

  let agentId = await resolveAgent(db, input?.agent as string | undefined)
  if (!agentId) {
    if (input?.agent) return `No agent named "${input.agent}". Omit "agent" to use the default loop agent.`
    agentId = await findOrCreateLoopAgent(db, userId)
  }
  const feedbackToolId = input?.feedback_tool ? await resolveFeedbackTool(db, String(input.feedback_tool)) : null
  if (input?.feedback_tool && !feedbackToolId) {
    return `No http tool named "${input.feedback_tool}" to use as the feedback source.`
  }

  let loop: { id: string; name: string }
  try {
    loop = await createLoop(db, userId, {
      name: input?.name,
      goal,
      rubric: input?.rubric,
      max_iterations: input?.max_iterations,
      budget_usd: input?.budget_usd,
      target_score: input?.target_score,
      agent_id: agentId,
      feedback_tool_id: feedbackToolId,
    })
  } catch (err) {
    return `Could not create the loop: ${err instanceof Error ? err.message : 'error'}`
  }

  try {
    const { run_id } = await triggerLoopRun(loop.id, userId)
    await logActivity(db, 'loop.started', `Started loop "${loop.name}"`, { loop_id: loop.id, run_id }, userId)
    return `Started loop "${loop.name}" (run id ${run_id}). It iterates in the background up to its budget/iteration cap. Call check_loop with run_id "${run_id}" to see progress and the best result so far.`
  } catch (err) {
    return `Created the loop but could not start it: ${err instanceof Error ? err.message : 'error'}`
  }
}

async function checkLoop(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Loops are unavailable.'
  const runId = String(input?.run_id ?? '').trim()
  const loopRef = String(input?.loop ?? '').trim()
  // deno-lint-ignore no-explicit-any
  let run: any = null
  if (runId) run = await getRun(db, runId)
  else if (loopRef) {
    const loop = await resolveLoop(db, userId, loopRef)
    if (!loop) return `No loop named "${loopRef}" that you can access.`
    run = await latestRunForLoop(db, loop.id)
  } else {
    return 'Pass a run_id (from start_loop) or a loop name/id to check.'
  }
  if (!run) return 'No run found yet.'
  return formatRun(run)
}

async function listLoops(db: DB | null, userId: string | null): Promise<string> {
  if (!db || !userId) return 'Loops are unavailable.'
  const out = await listLoopsText(db, userId)
  return out === 'No loops yet.' ? 'No loops yet. Use start_loop to create and run one.' : out
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

async function updateTableRow(
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
  if (!values || typeof values !== 'object' || !Object.keys(values).length) {
    return 'Pass the columns to change as a "values" object.'
  }
  // Require a filter so we never rewrite the whole table by accident.
  const filters = (input?.match ?? input?.filters ?? null) as Record<string, unknown> | null
  if (!filters || typeof filters !== 'object' || !Object.keys(filters).length) {
    return 'Pass a "match" object (e.g. {"id": 3}) identifying which row(s) to update.'
  }

  const allowed = new Set((t.columns ?? []).map((c) => c.key))
  const patch: Record<string, unknown> = {}
  const skipped: string[] = []
  for (const [k, v] of Object.entries(values)) {
    if (allowed.has(k)) patch[k] = v
    else skipped.push(k)
  }
  if (!Object.keys(patch).length) return 'None of the given values match this table\'s columns.'

  const matchable = new Set([...allowed, 'id', 'owner_id'])
  // deno-lint-ignore no-explicit-any
  let q: any = db.from(t.physical_name).update(patch)
  const badFilters: string[] = []
  for (const [k, v] of Object.entries(filters)) {
    if (matchable.has(k)) q = q.eq(k, v)
    else badFilters.push(k)
  }
  if (badFilters.length === Object.keys(filters).length) {
    return `None of the match columns exist on "${t.name}" (${badFilters.join(', ')}).`
  }
  const { data, error } = await q.select('id')
  if (error) return `Could not update "${t.name}": ${error.message}`
  const count = Array.isArray(data) ? data.length : 0
  if (!count) return `No matching rows in "${t.name}" — nothing updated.`
  const notes: string[] = []
  if (skipped.length) notes.push(`ignored unknown columns: ${skipped.join(', ')}`)
  if (badFilters.length) notes.push(`ignored unknown match columns: ${badFilters.join(', ')}`)
  const note = notes.length ? ` (${notes.join('; ')})` : ''
  return `Updated ${count} row${count === 1 ? '' : 's'} in "${t.name}".${note}`
}

async function deleteTableRow(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Tables are unavailable.'
  const ref = String(input?.table ?? '').trim()
  if (!ref) return 'Which table? Pass a table name.'
  const t = findTable(await accessibleTables(db, userId), ref)
  if (!t) return `No table named "${ref}" that you can access.`

  // One row by id only — no bulk match, so a loose filter can't wipe a table.
  const rowId = String(input?.row_id ?? '').trim()
  if (!rowId) return 'Pass the "row_id" of the row to delete (query_table returns each row\'s id).'

  const { data, error } = await db.from(t.physical_name).delete().eq('id', rowId).select('id')
  if (error) return `Could not delete from "${t.name}": ${error.message}`
  if (!data || !data.length) return `No row with id ${rowId} in "${t.name}" — nothing deleted.`
  return `Deleted row ${rowId} from "${t.name}".`
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

// --- Content authoring (artifacts / collections / knowledge) -----------------
// The in-app mirror of the MCP server's authoring actions, so the internal AI and
// agents can centralize content the team can chat with. All run with the service
// role and re-enforce access in code: artifacts/collections are created owned by
// the caller; resolveCollection only ever resolves the caller's own or a
// workspace-shared collection. The "ingest GitHub articles into a collection"
// flow lives here, and — because all three loops share runBuiltin — a scheduled
// or webhook-driven agent can keep that collection updated too.

// Resolve a collection by id or name for this caller (own + workspace-shared);
// optionally create it (owned by the caller, private) when missing.
async function resolveCollection(
  db: DB,
  owner: string,
  ref: string,
  createIfMissing: boolean,
): Promise<{ id: string; name: string } | null> {
  const r = ref.trim()
  if (!r) return null
  const { data } = await db
    .from('collections')
    .select('id, name, owner_id, visibility')
    .or(`owner_id.eq.${owner},visibility.eq.workspace`)
  const found = (data ?? []).find(
    (c: { id: string; name: string }) => c.id === r || c.name.trim().toLowerCase() === r.toLowerCase(),
  )
  if (found) return { id: found.id, name: found.name }
  if (!createIfMissing) return null
  const { data: created } = await db
    .from('collections')
    .insert({ owner_id: owner, name: r, visibility: 'private' })
    .select('id, name')
    .single()
  return created ? { id: created.id, name: created.name } : null
}

async function createArtifact(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Creating artifacts is unavailable.'
  const title = String(input?.title ?? '').trim()
  const content = String(input?.content ?? '')
  if (!title) return 'An artifact title is required.'
  if (!content.trim()) return 'The artifact needs some content.'
  const type = ['markdown', 'code', 'html', 'text'].includes(String(input?.type)) ? String(input?.type) : 'markdown'
  const { data, error } = await db
    .from('artifacts')
    .insert({ owner_id: userId, title, type, content, visibility: 'private' })
    .select('id')
    .single()
  if (error) return `Could not create the artifact: ${error.message}`
  let note = ''
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, true)
    if (col) {
      await db.from('collection_artifacts').upsert(
        { collection_id: col.id, artifact_id: data.id, added_by: userId },
        { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
      )
      note = ` Filed into collection "${col.name}".`
    }
  }
  await logActivity(db, 'artifact.created', `Created artifact "${title}"`, { id: data.id, collection: ref || null }, userId)
  return `Created artifact "${title}" at /artifacts/${data.id}.${note}`
}

async function listCollections(db: DB | null, userId: string | null): Promise<string> {
  if (!db || !userId) return 'Collections are unavailable.'
  const { data } = await db
    .from('collections')
    .select('id, name, description, visibility, owner_id')
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .order('name', { ascending: true })
  if (!data || !data.length) return 'No collections yet. Use create_collection to make one.'
  return (data as Array<{ id: string; name: string; description: string; visibility: string }>)
    .map((c) => `• ${c.name} (${c.id}) [${c.visibility}]${c.description ? ` — ${c.description}` : ''}`)
    .join('\n')
}

async function createCollection(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Collections are unavailable.'
  const name = String(input?.name ?? '').trim()
  if (!name) return 'A collection name is required.'
  const { data, error } = await db
    .from('collections')
    .insert({
      owner_id: userId,
      name,
      description: String(input?.description ?? ''),
      visibility: input?.shared === true ? 'workspace' : 'private',
    })
    .select('id, name, visibility')
    .single()
  if (error) return `Could not create the collection: ${error.message}`
  await logActivity(db, 'collection.created', `Created collection "${data.name}"`, { id: data.id }, userId)
  return `Created collection "${data.name}" (id ${data.id}, ${data.visibility}). Add artifacts with create_artifact (collection: "${data.name}") or add_to_collection.`
}

async function addToCollection(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Collections are unavailable.'
  const ref = String(input?.collection ?? '').trim()
  const artifactId = String(input?.artifact_id ?? '').trim()
  if (!ref || !artifactId) return 'Pass both a collection (name or id) and an artifact_id.'
  const col = await resolveCollection(db, userId, ref, true)
  if (!col) return `Could not resolve collection "${ref}".`
  const { error } = await db.from('collection_artifacts').upsert(
    { collection_id: col.id, artifact_id: artifactId, added_by: userId },
    { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
  )
  if (error) return `Could not add to the collection: ${error.message}`
  return `Added artifact ${artifactId} to collection "${col.name}".`
}

async function addNote(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'The knowledge base is unavailable.'
  const title = String(input?.title ?? '').trim()
  const content = String(input?.content ?? '')
  if (!title) return 'A note title is required.'
  if (content.trim().length < 20) return 'That note is too short to index — provide at least ~20 characters of text.'
  const scope = input?.scope === 'private' ? 'private' : 'workspace'
  try {
    const { chunkCount } = await ingestText(db, { ownerId: userId, name: title, text: content, scope })
    return `Added "${title}" to the knowledge base (${chunkCount} chunk${chunkCount === 1 ? '' : 's'}, ${
      scope === 'workspace' ? 'searchable by the whole team' : 'visible only to you'
    }). Find it later via search_documents.`
  } catch (err) {
    return `Could not add the note: ${err instanceof Error ? err.message : 'error'}`
  }
}

// Accept YYYY-MM-DD (or null to clear); returns undefined for invalid input.
function normalizeDue(v: unknown): string | null | undefined {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined
}

async function createTodo(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'To-dos are unavailable.'
  const title = String(input?.title ?? '').trim()
  if (!title) return 'A to-do title is required.'
  const due = normalizeDue(input?.due_date)
  if (due === undefined && input?.due_date !== undefined) return 'due_date must be YYYY-MM-DD.'
  const { data, error } = await db
    .from('todos')
    .insert({
      owner_id: userId,
      title,
      notes: String(input?.notes ?? ''),
      due_date: due ?? null,
      visibility: 'private',
    })
    .select('id')
    .single()
  if (error) return `Could not create the to-do: ${error.message}`
  let note = ''
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, true)
    if (col) {
      await db.from('collection_todos').upsert(
        { collection_id: col.id, todo_id: data.id, added_by: userId },
        { onConflict: 'collection_id,todo_id', ignoreDuplicates: true },
      )
      note = ` Filed into collection "${col.name}".`
    }
  }
  await logActivity(db, 'todo.created', `Created to-do "${title}"`, { id: data.id, collection: ref || null }, userId)
  return `Created to-do "${title}" (id ${data.id})${due ? `, due ${due}` : ''}.${note}`
}

async function listTodos(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'To-dos are unavailable.'
  let query = db
    .from('todos')
    .select('id, title, due_date, done')
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .order('done', { ascending: true })
    .order('due_date', { ascending: true, nullsFirst: false })
  if (input?.status === 'done') query = query.eq('done', true)
  else if (input?.status === 'open') query = query.eq('done', false)
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, false)
    if (!col) return `Collection "${ref}" not found.`
    const { data: members } = await db.from('collection_todos').select('todo_id').eq('collection_id', col.id)
    const ids = (members ?? []).map((m: { todo_id: string }) => m.todo_id)
    if (!ids.length) return `No to-dos in collection "${col.name}".`
    query = query.in('id', ids)
  }
  const { data } = await query
  if (!data || !data.length) return 'No to-dos.'
  return (data as Array<{ id: string; title: string; due_date: string | null; done: boolean }>)
    .map((t) => `• [${t.done ? 'x' : ' '}] ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''} — ${t.id}`)
    .join('\n')
}

async function completeTodo(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'To-dos are unavailable.'
  const id = String(input?.id ?? '').trim()
  if (!id) return 'A to-do id is required.'
  const { data, error } = await db
    .from('todos')
    .update({ done: true, completed_at: new Date().toISOString() })
    .eq('id', id)
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .select('id')
    .maybeSingle()
  if (error) return `Could not complete the to-do: ${error.message}`
  if (!data) return `To-do ${id} not found (or not yours).`
  await logActivity(db, 'todo.completed', `Completed a to-do`, { id }, userId)
  return `Marked to-do ${id} as done.`
}

async function updateTodo(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'To-dos are unavailable.'
  const id = String(input?.id ?? '').trim()
  if (!id) return 'A to-do id is required.'
  const patch: Record<string, unknown> = {}
  if (typeof input?.title === 'string' && input.title.trim()) patch.title = input.title.trim()
  if (typeof input?.notes === 'string') patch.notes = input.notes
  if (input?.due_date !== undefined) {
    const due = normalizeDue(input.due_date)
    if (due === undefined) return 'due_date must be YYYY-MM-DD or null.'
    patch.due_date = due
  }
  if (typeof input?.done === 'boolean') {
    patch.done = input.done
    patch.completed_at = input.done ? new Date().toISOString() : null
  }
  if (Object.keys(patch).length === 0) return 'No fields to update.'
  const { data, error } = await db
    .from('todos')
    .update(patch)
    .eq('id', id)
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .select('id')
    .maybeSingle()
  if (error) return `Could not update the to-do: ${error.message}`
  if (!data) return `To-do ${id} not found (or not yours).`
  return `Updated to-do ${id}.`
}

async function addTodoToCollection(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'To-dos are unavailable.'
  const ref = String(input?.collection ?? '').trim()
  const todoId = String(input?.todo_id ?? '').trim()
  if (!ref || !todoId) return 'Pass both a collection (name or id) and a todo_id.'
  const col = await resolveCollection(db, userId, ref, true)
  if (!col) return `Could not resolve collection "${ref}".`
  const { error } = await db.from('collection_todos').upsert(
    { collection_id: col.id, todo_id: todoId, added_by: userId },
    { onConflict: 'collection_id,todo_id', ignoreDuplicates: true },
  )
  if (error) return `Could not add to the collection: ${error.message}`
  return `Added to-do ${todoId} to collection "${col.name}".`
}

// --- Links (shared bookmarks; metadata auto-fetched from the URL) -----------

async function saveLink(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Links are unavailable.'
  const url = String(input?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) return 'A full http(s) url is required.'
  const meta = await fetchLinkMetadata(url)
  const title = (typeof input?.title === 'string' && input.title.trim()) || meta.title
  const { data, error } = await db
    .from('links')
    .insert({
      owner_id: userId,
      url,
      title,
      description: meta.description,
      image_url: meta.image_url,
      favicon_url: meta.favicon_url,
      notes: String(input?.notes ?? ''),
      visibility: 'private',
    })
    .select('id')
    .single()
  if (error) return `Could not save the link: ${error.message}`
  let note = ''
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, true)
    if (col) {
      await db.from('collection_links').upsert(
        { collection_id: col.id, link_id: data.id, added_by: userId },
        { onConflict: 'collection_id,link_id', ignoreDuplicates: true },
      )
      note = ` Filed into collection "${col.name}".`
    }
  }
  await logActivity(db, 'link.created', `Saved link "${title}"`, { id: data.id, url, collection: ref || null }, userId)
  return `Saved link "${title}" (id ${data.id}).${meta.description ? ` ${meta.description.slice(0, 200)}` : ''}${note}`
}

async function listLinks(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Links are unavailable.'
  let query = db
    .from('links')
    .select('id, url, title, description')
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .order('created_at', { ascending: false })
    .limit(100)
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, false)
    if (!col) return `Collection "${ref}" not found.`
    const { data: members } = await db.from('collection_links').select('link_id').eq('collection_id', col.id)
    const ids = (members ?? []).map((m: { link_id: string }) => m.link_id)
    if (!ids.length) return `No links in collection "${col.name}".`
    query = query.in('id', ids)
  }
  const { data } = await query
  if (!data || !data.length) return 'No saved links. Use save_link to add one.'
  return (data as Array<{ id: string; url: string; title: string; description: string }>)
    .map((l) => `• ${l.title} — ${l.url}${l.description ? `\n  ${l.description.slice(0, 200)}` : ''}\n  id: ${l.id}`)
    .join('\n')
}

async function addLinkToCollection(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Links are unavailable.'
  const ref = String(input?.collection ?? '').trim()
  const linkId = String(input?.link_id ?? '').trim()
  if (!ref || !linkId) return 'Pass both a collection (name or id) and a link_id.'
  const col = await resolveCollection(db, userId, ref, true)
  if (!col) return `Could not resolve collection "${ref}".`
  const { error } = await db.from('collection_links').upsert(
    { collection_id: col.id, link_id: linkId, added_by: userId },
    { onConflict: 'collection_id,link_id', ignoreDuplicates: true },
  )
  if (error) return `Could not add to the collection: ${error.message}`
  return `Added link ${linkId} to collection "${col.name}".`
}

async function addTableToCollection(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Tables are unavailable.'
  const ref = String(input?.collection ?? '').trim()
  const tableRef = String(input?.table ?? '').trim()
  if (!ref || !tableRef) return 'Pass both a collection (name or id) and a table (name or id).'
  const t = findTable(await accessibleTables(db, userId), tableRef)
  if (!t) return `No table named "${tableRef}" that you can access.`
  const col = await resolveCollection(db, userId, ref, true)
  if (!col) return `Could not resolve collection "${ref}".`
  const { error } = await db.from('collection_tables').upsert(
    { collection_id: col.id, table_id: t.id, added_by: userId },
    { onConflict: 'collection_id,table_id', ignoreDuplicates: true },
  )
  if (error) return `Could not add to the collection: ${error.message}`
  return `Added table "${t.name}" to collection "${col.name}".`
}
