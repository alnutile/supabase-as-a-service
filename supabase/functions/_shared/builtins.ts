// Shared executor for `builtin` tools — tools run in-function (as opposed to
// `http` tools that POST to a URL, or `web` tools that switch on OpenRouter's
// web-search plugin). Chat, evals and the MCP server all run them through here.
//
// Builtins: search_documents (RAG over uploaded files), the user-table tools
// (list_tables / query_table / add_table_row / update_table_row /
// delete_table_row / create_table), the team-vault tools (list_secrets /
// get_secret), and the content-authoring tools (artifacts, collections, notes,
// to-dos, links, whiteboards, card boards, terminology, files, memory, skills).
// get_secret returns a raw credential, so every use is logged. The table, vault,
// and authoring builtins run with the service role, so they re-enforce the
// private/workspace access rule in code (owner = caller).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import {
  artifactUrlLines,
  artifactUrls,
  clampLimit,
  collectionRefs,
  isArtifactId,
  makeSlug,
  normalizeArtifactType,
  resolveAppUrl,
} from './artifacts.ts'
import {
  formatTodoList,
  normalizeTodoVisibility,
  TODO_VISIBILITIES,
  type TodoListRow,
  visibilityNote,
} from './todos.ts'
import { ingestText } from './knowledge.ts'
import { citationLabel, hybridChunkSearch } from './retrieval.ts'
import { addFileToCollection, createFile, deleteFile, getFile, listFiles } from './files.ts'
import { forget, listMemories, remember, updateMemory } from './memory.ts'
import { hostOf, resolveVaultRefs } from './http_tool.ts'
import { runSecurityScan } from './security_scan.ts'
import { summarizeResource } from './resource_summarizer.ts'
import { dateColumn, formatLinkList, type LinkRow, parseDateBound } from './links.ts'
import { fetchLinkMetadata } from './linkmeta.ts'
import { htmlToMarkdown } from './html_markdown.ts'
import { buildScene, elementCount, sceneToText } from './whiteboard_scene.ts'
import { buildCards, cardCount, cardsToText } from './card_board.ts'
import { validateWidget } from './widgets.ts'

type DB = ReturnType<typeof createClient>


export async function runBuiltin(
  db: DB | null,
  name: string,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  switch (name) {
    case 'search_documents':
      return searchDocuments(db, input, userId)
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
    case 'list_artifacts':
      return listArtifacts(db, input, userId)
    case 'get_artifact':
      return getArtifact(db, input, userId)
    case 'update_artifact':
      return updateArtifact(db, input, userId)
    case 'delete_artifact':
      return deleteArtifact(db, input, userId)
    case 'restore_artifact':
      return restoreArtifact(db, input, userId)
    case 'share_artifact':
      return shareArtifact(db, input, userId)
    case 'list_collections':
      return listCollections(db, userId)
    case 'create_collection':
      return createCollection(db, input, userId)
    case 'add_to_collection':
      return addToCollection(db, input, userId)
    case 'add_note':
      return addNote(db, input, userId)
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
    case 'create_whiteboard':
      return createWhiteboard(db, input, userId)
    case 'list_whiteboards':
      return listWhiteboards(db, input, userId)
    case 'get_whiteboard':
      return getWhiteboard(db, input, userId)
    case 'update_whiteboard':
      return updateWhiteboard(db, input, userId)
    case 'add_whiteboard_to_collection':
      return addWhiteboardToCollection(db, input, userId)
    case 'create_card_board':
      return createCardBoard(db, input, userId)
    case 'list_card_boards':
      return listCardBoards(db, input, userId)
    case 'get_card_board':
      return getCardBoard(db, input, userId)
    case 'add_cards':
      return addCards(db, input, userId)
    case 'add_card_board_to_collection':
      return addCardBoardToCollection(db, input, userId)
    case 'create_term':
      return createTerm(db, input, userId)
    case 'list_terms':
      return listTerms(db, input, userId)
    case 'update_term':
      return updateTerm(db, input, userId)
    case 'delete_term':
      return deleteTerm(db, input, userId)
    case 'add_term_to_collection':
      return addTermToCollection(db, input, userId)
    case 'save_link':
      return saveLink(db, input, userId)
    case 'list_links':
      return listLinks(db, input, userId)
    case 'add_link_to_collection':
      return addLinkToCollection(db, input, userId)
    case 'set_link_screenshot':
      return setLinkScreenshot(db, input, userId)
    case 'add_table_to_collection':
      return addTableToCollection(db, input, userId)
    case 'create_file':
      return createFile(db, userId, input)
    case 'list_files':
      return listFiles(db, userId, input)
    case 'get_file':
      return getFile(db, userId, input)
    case 'delete_file':
      return deleteFile(db, userId, input)
    case 'add_file_to_collection':
      return addFileToCollection(db, userId, input)
    case 'remember':
      return remember(db, userId, input)
    case 'list_memories':
      return listMemories(db, userId, input)
    case 'update_memory':
      return updateMemory(db, userId, input)
    case 'forget':
      return forget(db, userId, input)
    case 'create_widget':
      return createWidget(db, input, userId)
    case 'list_widgets':
      return listWidgets(db, userId)
    case 'remove_widget':
      return removeWidget(db, input, userId)
    case 'http_request':
      return httpRequest(db, input, userId)
    case 'run_security_scan':
      return runSecurityScan(db, userId)
    case 'summarize_resource':
      return summarizeResource(db, input, userId)
    case 'create_skill':
      return createSkill(db, input, userId)
    case 'list_skills':
      return listSkills(db, input, userId)
    case 'get_skill':
      return getSkill(db, input, userId)
    case 'update_skill':
      return updateSkill(db, input, userId)
    case 'delete_skill':
      return deleteSkill(db, input, userId)
    case 'restore_skill':
      return restoreSkill(db, input, userId)
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

// ── Dashboard widgets ───────────────────────────────────────────────────────
// The AI composes a Home-dashboard tile from a description. validateWidget
// enforces the kind/source allow-list + sanitizes the spec; the dashboard runs
// the widget's query under RLS, so a stored spec can never read other users'
// rows. Owner-only table → we insert as the caller.
async function createWidget(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Dashboard widgets are unavailable.'
  const valid = validateWidget(input)
  if (typeof valid === 'string') return `Could not create the widget: ${valid}`
  const { data, error } = await db
    .from('dashboard_widgets')
    .insert({
      owner_id: userId,
      title: valid.title,
      kind: valid.kind,
      source: valid.source,
      spec: valid.spec,
    })
    .select('id')
    .single()
  if (error) return `Could not create the widget: ${error.message}`
  await logActivity(
    db,
    'widget.created',
    `Added dashboard widget "${valid.title}"`,
    { id: data.id, kind: valid.kind, source: valid.source },
    userId,
  )
  return `Added the "${valid.title}" widget (${valid.kind} of ${valid.source}) to your dashboard. It will appear on Home right away.`
}

async function listWidgets(db: DB | null, userId: string | null): Promise<string> {
  if (!db || !userId) return 'Dashboard widgets are unavailable.'
  const { data, error } = await db
    .from('dashboard_widgets')
    .select('id, title, kind, source')
    .eq('owner_id', userId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) return `Could not list widgets: ${error.message}`
  if (!data || data.length === 0) return 'You have no dashboard widgets yet.'
  return data
    .map((w) => `- ${w.title} (${w.kind} of ${w.source}) — id ${w.id}`)
    .join('\n')
}

async function removeWidget(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Dashboard widgets are unavailable.'
  const id = String(input?.id ?? '').trim()
  if (!id) return 'A widget id is required (use list_widgets to find it).'
  const { data, error } = await db
    .from('dashboard_widgets')
    .delete()
    .eq('id', id)
    .eq('owner_id', userId)
    .select('title')
    .maybeSingle()
  if (error) return `Could not remove the widget: ${error.message}`
  if (!data) return 'No widget with that id (or not yours).'
  await logActivity(db, 'widget.removed', `Removed dashboard widget "${data.title}"`, { id }, userId)
  return `Removed the "${data.title}" widget from your dashboard.`
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

// search_documents: HYBRID retrieval over the workspace's shared knowledge plus
// the caller's own private documents (both RLS-scoped in the RPCs, service-role
// only). We embed the query with the free in-edge gte-small model and run a
// pgvector semantic search AND a Postgres full-text keyword search in parallel,
// then fuse the two rankings with reciprocal-rank fusion (_shared/retrieval.ts).
// Keyword catches exact terms/names/IDs that vector similarity misses; vector
// catches paraphrases keyword misses. If the keyword query is empty or that RPC
// yields nothing, fusion degrades gracefully to the vector list alone.
async function searchDocuments(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Document search is unavailable.'
  const query = String(input?.query ?? '').trim()
  if (!query) return 'No matching passages found in the documents.'
  try {
    // deno-lint-ignore no-explicit-any
    const model = new (globalThis as any).Supabase.ai.Session('gte-small')
    const embedding = await model.run(query, { mean_pool: true, normalize: true })
    const { hits } = await hybridChunkSearch(db, { embedding, queryText: query, ownerId: userId, top: 6, pool: 24 })
    if (hits.length === 0) {
      // Explicit gap signal ("think" mode): tell the model the KB is silent here so
      // it states that rather than inventing an answer.
      return 'No passages in the knowledge base match this query. The knowledge base appears to have nothing indexed on this topic — say so instead of guessing.'
    }
    return hits
      .map((d, i) => `[${i + 1}] (${citationLabel(d)}) ${d.content}`)
      .join('\n\n---\n\n')
  } catch (err) {
    return `Document search failed: ${err instanceof Error ? err.message : 'error'}`
  }
}

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

// File an artifact into each named collection (name or id; created if missing),
// atomically per-collection. Returns the names actually filed into so the caller
// can confirm the linkage — the whole point of the "put this in collection X" flow.
async function fileArtifactIntoCollections(
  db: DB,
  userId: string,
  artifactId: string,
  refs: string[],
): Promise<string[]> {
  const filed: string[] = []
  for (const ref of refs) {
    const col = await resolveCollection(db, userId, ref, true)
    if (!col) continue
    const { error } = await db.from('collection_artifacts').upsert(
      { collection_id: col.id, artifact_id: artifactId, added_by: userId },
      { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
    )
    if (!error && !filed.includes(col.name)) filed.push(col.name)
  }
  return filed
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
  const type = normalizeArtifactType(input?.type)
  const { data, error } = await db
    .from('artifacts')
    .insert({ owner_id: userId, title, type, content, visibility: 'private' })
    .select('id, type, visibility, public_slug')
    .single()
  if (error) return `Could not create the artifact: ${error.message}`
  // Reads run against the primary (this same connection), so the row — and its id —
  // is queryable immediately by list_artifacts / get_artifact within the same turn.
  const refs = collectionRefs(input)
  const filed = refs.length ? await fileArtifactIntoCollections(db, userId, data.id, refs) : []
  const note = filed.length ? ` Filed into collection${filed.length > 1 ? 's' : ''}: ${filed.join(', ')}.` : ''
  await logActivity(db, 'artifact.created', `Created artifact "${title}"`, { id: data.id, collections: filed }, userId)
  const u = artifactUrls(data, appUrl())
  return `Created artifact "${title}" (id ${data.id}) at ${u.url}.${note} It is private (public_url: null) — use share_artifact to get a public link.`
}

// The app origin for absolute artifact URLs (APP_URL / SITE_URL env; see
// resolveAppUrl). Read per call so a secret change applies without a redeploy.
function appUrl(): string {
  return resolveAppUrl((k) => Deno.env.get(k))
}

// list_artifacts: the retrieval gap-filler. After create_artifact (or a :::artifact
// auto-save), the assistant can list its artifacts — newest first, with real ids —
// so it can then add_to_collection / get_artifact them. Scoped to what the caller
// can read (own + shared), optionally filtered by collection / title / type.
async function listArtifacts(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Artifacts are unavailable.'
  const limit = clampLimit(input?.limit, 20, 100)

  // Optional collection filter → restrict to that collection's member ids.
  let memberIds: string[] | null = null
  const colRef = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (colRef) {
    const col = await resolveCollection(db, userId, colRef, false)
    if (!col) return `Collection "${colRef}" not found.`
    const { data: members } = await db.from('collection_artifacts').select('artifact_id').eq('collection_id', col.id)
    memberIds = (members ?? []).map((m: { artifact_id: string }) => m.artifact_id)
    if (!memberIds.length) return `No artifacts in collection "${col.name}".`
  }

  // `archived:true` is the recovery area — only the caller's archived artifacts
  // (nobody else's trash is visible); otherwise only live (non-archived) rows.
  const wantArchived = input?.archived === true
  let query = db
    .from('artifacts')
    .select('id, title, type, created_at, visibility, public_slug')
    .order('created_at', { ascending: false })
    .limit(limit)
  query = wantArchived
    ? query.eq('owner_id', userId).not('deleted_at', 'is', null)
    : query.or(`owner_id.eq.${userId},visibility.neq.private`).is('deleted_at', null)
  const titleContains = typeof input?.title_contains === 'string' ? input.title_contains.trim() : ''
  if (titleContains) query = query.ilike('title', `%${titleContains}%`)
  // Artifacts have a `type` (markdown|code|html|text), not a MIME type; accept
  // either arg name so callers reaching for `mime_type` still filter by type.
  const typeFilter = String(input?.type ?? input?.mime_type ?? '').trim().toLowerCase()
  if (['markdown', 'code', 'html', 'text'].includes(typeFilter)) query = query.eq('type', typeFilter)
  if (memberIds) query = query.in('id', memberIds)

  const { data, error } = await query
  if (error) return `Could not list artifacts: ${error.message}`
  const rows = (data ?? []) as Array<
    { id: string; title: string; type: string; created_at: string; visibility: string; public_slug: string | null }
  >
  if (!rows.length) return 'No artifacts match. Use create_artifact to make one.'

  const cols = await artifactCollectionsMap(db, rows.map((r) => r.id))
  const base = appUrl()
  return rows
    .map((r) => {
      const inCols = cols.get(r.id) ?? []
      const when = new Date(r.created_at).toISOString().slice(0, 10)
      const u = artifactUrls(r, base)
      return `• ${r.title} (${r.type}) — id: ${r.id} — created ${when}${
        inCols.length ? ` — collections: ${inCols.join(', ')}` : ''
      } — ${u.url} — visibility: ${r.visibility} — public_url: ${u.public_url ?? 'null'}${
        u.standalone_url ? ` — standalone_url: ${u.standalone_url}` : ''
      }`
    })
    .join('\n')
}

// Map artifact id → collection names it belongs to (for the given ids only).
async function artifactCollectionsMap(db: DB, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (!ids.length) return map
  const { data } = await db
    .from('collection_artifacts')
    .select('artifact_id, collections(name)')
    .in('artifact_id', ids)
  for (const row of (data ?? []) as Array<{ artifact_id: string; collections: { name: string } | null }>) {
    const name = row.collections?.name
    if (!name) continue
    const list = map.get(row.artifact_id) ?? []
    list.push(name)
    map.set(row.artifact_id, list)
  }
  return map
}

const ARTIFACT_CONTENT_CAP = 16_000

// Find one artifact by id or exact title (case-insensitive). `ownOnly` mirrors
// the write rule: reads follow the RLS shape (owner OR shared), updates are
// owner-only — builtins run as the service role, so this re-check is the gate.
// `archived` picks the trash state: 'live' (default, not archived), 'archived'
// (only archived — for restore), or 'any' (either — for a permanent delete).
async function resolveArtifact(
  db: DB,
  userId: string,
  ref: string,
  ownOnly: boolean,
  archived: 'live' | 'archived' | 'any' = 'live',
): Promise<ResolvedArtifact | null> {
  let q = db
    .from('artifacts')
    .select('id, title, type, content, data, owner_id, visibility, public_slug, updated_at')
  q = ownOnly ? q.eq('owner_id', userId) : q.or(`owner_id.eq.${userId},visibility.neq.private`)
  if (archived === 'live') q = q.is('deleted_at', null)
  else if (archived === 'archived') q = q.not('deleted_at', 'is', null)
  q = isArtifactId(ref) ? q.eq('id', ref) : q.ilike('title', ref)
  const { data } = await q.order('updated_at', { ascending: false }).limit(1)
  return (data?.[0] as ResolvedArtifact | undefined) ?? null
}

type ResolvedArtifact = {
  id: string
  title: string
  type: string
  content: string
  data: unknown
  visibility: string
  public_slug: string | null
}

async function getArtifact(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Artifacts are unavailable.'
  const ref = String(input?.artifact ?? '').trim()
  if (!ref) return 'Pass the artifact id or its exact title.'
  const art = await resolveArtifact(db, userId, ref, false)
  if (!art) return `No artifact matches "${ref}".`
  const inCols = (await artifactCollectionsMap(db, [art.id])).get(art.id) ?? []
  const clipped = art.content.length > ARTIFACT_CONTENT_CAP
  const content = clipped ? art.content.slice(0, ARTIFACT_CONTENT_CAP) : art.content
  return [
    `id: ${art.id}`,
    `title: ${art.title}`,
    `type: ${art.type}`,
    ...artifactUrlLines(art, appUrl()),
    `collections: ${inCols.length ? inCols.join(', ') : '(none)'}`,
    `saved interactive state (data): ${JSON.stringify(art.data ?? {})}`,
    `content${clipped ? ` (first ${ARTIFACT_CONTENT_CAP} chars — it is longer)` : ''}:`,
    content,
  ].join('\n')
}

async function updateArtifact(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Artifacts are unavailable.'
  const ref = String(input?.artifact ?? '').trim()
  if (!ref) return 'Pass the artifact id or its exact title.'
  const art = await resolveArtifact(db, userId, ref, true)
  if (!art) return `No artifact you own matches "${ref}". Use get_artifact or create_artifact first.`

  const patch: Record<string, unknown> = {}
  if (typeof input?.title === 'string' && input.title.trim()) patch.title = input.title.trim().slice(0, 120)
  if (typeof input?.content === 'string' && input.content.trim()) patch.content = input.content
  if (input?.data !== undefined) {
    if (typeof input.data !== 'object' || input.data === null || Array.isArray(input.data)) {
      return 'data must be a JSON object.'
    }
    patch.data = input.data
  }
  if (!Object.keys(patch).length) return 'Nothing to update — pass title, content, and/or data.'

  const { error } = await db.from('artifacts').update(patch).eq('id', art.id).eq('owner_id', userId)
  if (error) return `Could not update the artifact: ${error.message}`
  await logActivity(
    db,
    'artifact.updated',
    `Updated artifact "${(patch.title as string) ?? art.title}"`,
    { id: art.id, fields: Object.keys(patch) },
    userId,
  )
  const u = artifactUrls(art, appUrl())
  return `Updated artifact "${(patch.title as string) ?? art.title}" (${u.url}). public_url: ${
    u.public_url ?? 'null (not shared)'
  }. Open views refresh live.`
}

// share_artifact: publish an artifact you own by link — the MCP/agent mirror of
// the editor's Sharing panel. Sets visibility to unlisted (default) or public and
// mints a public_slug when missing (same rule as ArtifactEditorPage's
// changeVisibility), then returns the ready-made public_url. Owner-only. A
// password-protected artifact keeps its password (viewers still get the gate).
async function shareArtifact(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Artifacts are unavailable.'
  const ref = String(input?.artifact ?? '').trim()
  if (!ref) return 'Pass the artifact id or its exact title.'
  const want = String(input?.visibility ?? 'unlisted').trim().toLowerCase()
  if (want !== 'unlisted' && want !== 'public') {
    return 'visibility must be "unlisted" (anyone with the link) or "public".'
  }
  const art = await resolveArtifact(db, userId, ref, true)
  if (!art) return `No artifact you own matches "${ref}".`
  const slug = art.public_slug || makeSlug()
  const { error } = await db
    .from('artifacts')
    .update({ visibility: want, public_slug: slug })
    .eq('id', art.id)
    .eq('owner_id', userId)
  if (error) return `Could not share the artifact: ${error.message}`
  await logActivity(db, 'artifact.shared', `Shared artifact "${art.title}" (${want})`, { id: art.id, visibility: want }, userId)
  const lines = artifactUrlLines({ ...art, visibility: want, public_slug: slug }, appUrl())
  return [`Shared artifact "${art.title}" (${want}).`, `id: ${art.id}`, ...lines].join('\n')
}

// Archive (soft delete) by default — hides the artifact from every normal view
// but keeps it recoverable; permanent:true removes the row for good. Owner only.
async function deleteArtifact(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Artifacts are unavailable.'
  const ref = String(input?.artifact ?? '').trim()
  if (!ref) return 'Pass the artifact id or its exact title.'
  const permanent = input?.permanent === true
  // Resolve across any trash state so a second "delete" on an already-archived
  // artifact can still escalate to a permanent removal.
  const art = await resolveArtifact(db, userId, ref, true, 'any')
  if (!art) return `No artifact you own matches "${ref}".`
  if (permanent) {
    const { error } = await db.from('artifacts').delete().eq('id', art.id).eq('owner_id', userId)
    if (error) return `Could not delete the artifact: ${error.message}`
    await logActivity(db, 'artifact.deleted', `Permanently deleted artifact "${art.title}"`, { id: art.id, permanent: true }, userId)
    return `Permanently deleted artifact "${art.title}". This cannot be undone.`
  }
  const { error } = await db
    .from('artifacts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', art.id)
    .eq('owner_id', userId)
  if (error) return `Could not archive the artifact: ${error.message}`
  await logActivity(db, 'artifact.archived', `Archived artifact "${art.title}"`, { id: art.id }, userId)
  return `Archived artifact "${art.title}". It's hidden from normal views but recoverable with restore_artifact (or delete it for good with permanent:true).`
}

async function restoreArtifact(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Artifacts are unavailable.'
  const ref = String(input?.artifact ?? '').trim()
  if (!ref) return 'Pass the artifact id or its exact title.'
  const art = await resolveArtifact(db, userId, ref, true, 'archived')
  if (!art) return `No archived artifact you own matches "${ref}". Use list_artifacts with archived:true to see the recovery area.`
  const { error } = await db
    .from('artifacts')
    .update({ deleted_at: null })
    .eq('id', art.id)
    .eq('owner_id', userId)
  if (error) return `Could not restore the artifact: ${error.message}`
  await logActivity(db, 'artifact.restored', `Restored artifact "${art.title}"`, { id: art.id }, userId)
  return `Restored artifact "${art.title}" (/artifacts/${art.id}). It's visible again.`
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
  if (!ref) return 'Pass a collection (name or id).'
  // Accept an artifact_id OR an artifact_title — so the assistant can file a
  // freshly-created artifact by title without ever having to see its id.
  let artifactId = String(input?.artifact_id ?? '').trim()
  const titleRef = String(input?.artifact_title ?? '').trim()
  if (!artifactId && titleRef) {
    const art = await resolveArtifact(db, userId, titleRef, false)
    if (!art) return `No artifact matches the title "${titleRef}".`
    artifactId = art.id
  }
  if (!artifactId) return 'Pass an artifact_id or an artifact_title.'
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

// The to-do lifecycle lanes (migration 0116). Returns the normalized lane,
// `null` for an unrecognised value, or `undefined` when nothing was passed.
const TODO_STATUSES = ['triage', 'next', 'doing', 'blocked', 'done']

function normalizeStatus(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim().toLowerCase()
  return TODO_STATUSES.includes(s) ? s : null
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
  const status = normalizeStatus(input?.status)
  if (status === null) return `status must be one of ${TODO_STATUSES.join(', ')}.`
  const visibility = normalizeTodoVisibility(input?.visibility)
  if (visibility === null) return `visibility must be one of ${TODO_VISIBILITIES.join(', ')}.`
  const { data, error } = await db
    .from('todos')
    .insert({
      owner_id: userId,
      title,
      notes: String(input?.notes ?? ''),
      due_date: due ?? null,
      // Default to 'triage', not 'next': a to-do the assistant filed has not
      // been agreed to by a person yet, and the Focus queue leads with exactly
      // that — unreviewed work an agent put on your plate.
      status: status ?? 'triage',
      // Only an agent loop or an external Claude reaches this handler, so the
      // provenance is never a guess.
      source: 'agent',
      // Private unless the caller asks for the team — an agent filing work at
      // one person shouldn't quietly publish it to everyone. Filing into a
      // workspace collection still promotes it (migration 0122).
      visibility: visibility ?? 'private',
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
  await logActivity(
    db,
    'todo.created',
    `Created to-do "${title}"`,
    { id: data.id, collection: ref || null, visibility: visibility ?? 'private' },
    userId,
  )
  // Only worth saying for the notable case — private is the default.
  const who = visibility === 'workspace' ? visibilityNote(visibility) : ''
  return `Created to-do "${title}" (id ${data.id})${due ? `, due ${due}` : ''} in the ${status ?? 'triage'} lane.${who}${note}`
}

async function listTodos(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'To-dos are unavailable.'
  let query = db
    .from('todos')
    .select('id, title, notes, due_date, done, status, source, visibility')
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .order('done', { ascending: true })
    .order('due_date', { ascending: true, nullsFirst: false })
  // `status` carries both readings: the original open|done filter and, since
  // migration 0116, a lane name. 'done' means the same thing under either.
  const want = typeof input?.status === 'string' ? input.status.trim().toLowerCase() : ''
  if (want === 'done') query = query.eq('done', true)
  else if (want === 'open') query = query.eq('done', false)
  else if (want && TODO_STATUSES.includes(want)) query = query.eq('status', want)
  else if (want) return `status must be open, done, or one of ${TODO_STATUSES.join(', ')}.`
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
  return formatTodoList(data as TodoListRow[])
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
  if (input?.status !== undefined) {
    const status = normalizeStatus(input.status)
    if (!status) return `status must be one of ${TODO_STATUSES.join(', ')}.`
    patch.status = status
  }
  if (typeof input?.done === 'boolean') {
    // Send only the half the caller named — the todos_sync_status trigger
    // derives the other, so `done` and `status` can never end up contradicting
    // each other no matter which one a tool call sets.
    if (patch.status === undefined) patch.done = input.done
  }
  const visibility = normalizeTodoVisibility(input?.visibility)
  if (visibility === null) return `visibility must be one of ${TODO_VISIBILITIES.join(', ')}.`
  if (visibility !== undefined) {
    // Every member can tick off or re-lane a workspace to-do, but only the owner
    // decides who sees it — otherwise one member could pull a shared to-do back
    // to private and hide it from the rest of the team.
    const { data: row } = await db.from('todos').select('owner_id').eq('id', id).maybeSingle()
    if (!row) return `To-do ${id} not found.`
    if (row.owner_id !== userId) return `Only the owner of to-do ${id} can change who can see it.`
    patch.visibility = visibility
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
  return `Updated to-do ${id}.${visibilityNote(visibility, 'is now')}`
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

// --- Whiteboards (Excalidraw canvases in the Planner) -----------------------
// Read a board as text (sceneToText) and DRAW on it by writing Excalidraw
// elements (buildScene turns skeleton elements into renderable ones). Access is
// re-enforced in code (own or workspace) because the loops run as service role.

async function createWhiteboard(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Whiteboards are unavailable.'
  const title = String(input?.title ?? '').trim()
  if (!title) return 'A whiteboard title is required.'
  const scene = input?.elements ? buildScene({}, input.elements, 'replace') : {}
  const { data, error } = await db
    .from('whiteboards')
    .insert({ owner_id: userId, title, scene, visibility: 'private' })
    .select('id')
    .single()
  if (error) return `Could not create the whiteboard: ${error.message}`
  let note = ''
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, true)
    if (col) {
      await db.from('collection_whiteboards').upsert(
        { collection_id: col.id, whiteboard_id: data.id, added_by: userId },
        { onConflict: 'collection_id,whiteboard_id', ignoreDuplicates: true },
      )
      note = ` Filed into collection "${col.name}".`
    }
  }
  const n = elementCount(scene)
  await logActivity(db, 'whiteboard.created', `Created whiteboard "${title}"`, { id: data.id, collection: ref || null }, userId)
  return `Created whiteboard "${title}" (id ${data.id})${n ? ` with ${n} element(s)` : ''} at /whiteboards/${data.id}.${note}`
}

async function listWhiteboards(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Whiteboards are unavailable.'
  let query = db
    .from('whiteboards')
    .select('id, title, updated_at')
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .order('updated_at', { ascending: false })
    .limit(clampLimit(input?.limit, 50, 200))
  const contains = typeof input?.title_contains === 'string' ? input.title_contains.trim() : ''
  if (contains) query = query.ilike('title', `%${contains.replace(/[%_]/g, '\\$&')}%`)
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, false)
    if (!col) return `Collection "${ref}" not found.`
    const { data: members } = await db
      .from('collection_whiteboards')
      .select('whiteboard_id')
      .eq('collection_id', col.id)
    const ids = (members ?? []).map((m: { whiteboard_id: string }) => m.whiteboard_id)
    if (!ids.length) return `No whiteboards in collection "${col.name}".`
    query = query.in('id', ids)
  }
  const { data } = await query
  if (!data || !data.length) return 'No whiteboards.'
  return (data as Array<{ id: string; title: string; updated_at: string }>)
    .map((w) => `• ${w.title} — ${w.id} (updated ${w.updated_at.slice(0, 10)})`)
    .join('\n')
}

// Find a whiteboard the caller may read, by id or exact title.
async function findWhiteboard(
  db: DB,
  userId: string,
  input: Record<string, unknown>,
): Promise<{ id: string; title: string; scene: unknown } | { error: string }> {
  const id = String(input?.id ?? '').trim()
  const title = String(input?.title ?? '').trim()
  if (!id && !title) return { error: 'Pass a whiteboard id or exact title.' }
  let q = db.from('whiteboards').select('id, title, scene').or(`owner_id.eq.${userId},visibility.eq.workspace`)
  q = id ? q.eq('id', id) : q.eq('title', title)
  const { data } = await q.limit(1).maybeSingle()
  if (!data) return { error: `Whiteboard ${id || `"${title}"`} not found (or not yours).` }
  return data as { id: string; title: string; scene: unknown }
}

async function getWhiteboard(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Whiteboards are unavailable.'
  const found = await findWhiteboard(db, userId, input)
  if ('error' in found) return found.error
  return `# Whiteboard: ${found.title} (id ${found.id})\n\n${sceneToText(found.scene)}`
}

async function updateWhiteboard(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Whiteboards are unavailable.'
  // `title` doubles as a lookup key when no id is given; only when an id is
  // supplied does `title` mean "rename to".
  const id = String(input?.id ?? '').trim()
  const found = await findWhiteboard(db, userId, input)
  if ('error' in found) return found.error
  const patch: Record<string, unknown> = {}
  if (id && typeof input?.title === 'string' && input.title.trim()) patch.title = input.title.trim()
  if (input?.elements !== undefined) {
    const mode = input?.mode === 'append' ? 'append' : 'replace'
    patch.scene = buildScene(found.scene, input.elements, mode)
  }
  if (Object.keys(patch).length === 0) return 'Nothing to update — pass `elements` to draw and/or (with an id) a new `title`.'
  const { error } = await db.from('whiteboards').update(patch).eq('id', found.id)
  if (error) return `Could not update the whiteboard: ${error.message}`
  await logActivity(db, 'whiteboard.updated', `Updated whiteboard "${found.title}"`, { id: found.id }, userId)
  const n = patch.scene ? elementCount(patch.scene) : undefined
  return `Updated whiteboard "${patch.title ?? found.title}" (id ${found.id})${n !== undefined ? ` — now ${n} element(s)` : ''}.`
}

async function addWhiteboardToCollection(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Whiteboards are unavailable.'
  const ref = String(input?.collection ?? '').trim()
  const whiteboardId = String(input?.whiteboard_id ?? '').trim()
  if (!ref || !whiteboardId) return 'Pass both a collection (name or id) and a whiteboard_id.'
  const col = await resolveCollection(db, userId, ref, true)
  if (!col) return `Could not resolve collection "${ref}".`
  const { error } = await db.from('collection_whiteboards').upsert(
    { collection_id: col.id, whiteboard_id: whiteboardId, added_by: userId },
    { onConflict: 'collection_id,whiteboard_id', ignoreDuplicates: true },
  )
  if (error) return `Could not add to the collection: ${error.message}`
  return `Added whiteboard ${whiteboardId} to collection "${col.name}".`
}

// --- Card boards (free-form wall of movable cards in the Planner) ------------
// Read a board as a prioritized list (cardsToText) and dump ideas onto it as
// cards (buildCards auto-positions them). Access re-enforced in code (own or
// workspace) since the loops run as service role.

async function createCardBoard(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Card boards are unavailable.'
  const title = String(input?.title ?? '').trim()
  if (!title) return 'A card board title is required.'
  const cards = input?.cards ? buildCards({}, input.cards, 'replace') : []
  const { data, error } = await db
    .from('card_boards')
    .insert({ owner_id: userId, title, cards, visibility: 'private' })
    .select('id')
    .single()
  if (error) return `Could not create the card board: ${error.message}`
  let note = ''
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, true)
    if (col) {
      await db.from('collection_card_boards').upsert(
        { collection_id: col.id, card_board_id: data.id, added_by: userId },
        { onConflict: 'collection_id,card_board_id', ignoreDuplicates: true },
      )
      note = ` Filed into collection "${col.name}".`
    }
  }
  const n = cardCount({ cards })
  await logActivity(db, 'card_board.created', `Created card board "${title}"`, { id: data.id, collection: ref || null }, userId)
  return `Created card board "${title}" (id ${data.id})${n ? ` with ${n} card(s)` : ''} at /cards/${data.id}.${note}`
}

async function listCardBoards(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Card boards are unavailable.'
  let query = db
    .from('card_boards')
    .select('id, title, updated_at')
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .order('updated_at', { ascending: false })
    .limit(clampLimit(input?.limit, 50, 200))
  const contains = typeof input?.title_contains === 'string' ? input.title_contains.trim() : ''
  if (contains) query = query.ilike('title', `%${contains.replace(/[%_]/g, '\\$&')}%`)
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, false)
    if (!col) return `Collection "${ref}" not found.`
    const { data: members } = await db
      .from('collection_card_boards')
      .select('card_board_id')
      .eq('collection_id', col.id)
    const ids = (members ?? []).map((m: { card_board_id: string }) => m.card_board_id)
    if (!ids.length) return `No card boards in collection "${col.name}".`
    query = query.in('id', ids)
  }
  const { data } = await query
  if (!data || !data.length) return 'No card boards.'
  return (data as Array<{ id: string; title: string; updated_at: string }>)
    .map((w) => `• ${w.title} — ${w.id} (updated ${w.updated_at.slice(0, 10)})`)
    .join('\n')
}

// Find a board the caller may read, by id or exact title.
async function findCardBoard(
  db: DB,
  userId: string,
  input: Record<string, unknown>,
): Promise<{ id: string; title: string; cards: unknown } | { error: string }> {
  const id = String(input?.id ?? '').trim()
  const title = String(input?.title ?? '').trim()
  if (!id && !title) return { error: 'Pass a card board id or exact title.' }
  let q = db.from('card_boards').select('id, title, cards').or(`owner_id.eq.${userId},visibility.eq.workspace`)
  q = id ? q.eq('id', id) : q.eq('title', title)
  const { data } = await q.limit(1).maybeSingle()
  if (!data) return { error: `Card board ${id || `"${title}"`} not found (or not yours).` }
  return data as { id: string; title: string; cards: unknown }
}

async function getCardBoard(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Card boards are unavailable.'
  const found = await findCardBoard(db, userId, input)
  if ('error' in found) return found.error
  return `# Card board: ${found.title} (id ${found.id})\n\n${cardsToText({ cards: found.cards })}`
}

async function addCards(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Card boards are unavailable.'
  if (!Array.isArray(input?.cards) || !input.cards.length) return 'Pass a non-empty `cards` array ({text, color?}).'
  const found = await findCardBoard(db, userId, input)
  if ('error' in found) return found.error
  const before = cardCount({ cards: found.cards })
  const cards = buildCards({ cards: found.cards }, input.cards, 'append')
  const { error } = await db.from('card_boards').update({ cards }).eq('id', found.id)
  if (error) return `Could not add cards: ${error.message}`
  const added = cardCount({ cards }) - before
  await logActivity(db, 'card_board.updated', `Added ${added} card(s) to "${found.title}"`, { id: found.id }, userId)
  return `Added ${added} card(s) to "${found.title}" (id ${found.id}) — now ${cardCount({ cards })} total.`
}

async function addCardBoardToCollection(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Card boards are unavailable.'
  const ref = String(input?.collection ?? '').trim()
  const boardId = String(input?.card_board_id ?? '').trim()
  if (!ref || !boardId) return 'Pass both a collection (name or id) and a card_board_id.'
  const col = await resolveCollection(db, userId, ref, true)
  if (!col) return `Could not resolve collection "${ref}".`
  const { error } = await db.from('collection_card_boards').upsert(
    { collection_id: col.id, card_board_id: boardId, added_by: userId },
    { onConflict: 'collection_id,card_board_id', ignoreDuplicates: true },
  )
  if (error) return `Could not add to the collection: ${error.message}`
  return `Added card board ${boardId} to collection "${col.name}".`
}

// --- Terminology (glossary of terms and definitions) ------------------------

async function createTerm(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Terminology is unavailable.'
  const term = String(input?.term ?? '').trim()
  const definition = String(input?.definition ?? '').trim()
  if (!term) return 'A term is required.'
  if (!definition) return 'A definition is required.'
  const { data, error } = await db
    .from('terminology')
    .insert({
      owner_id: userId,
      term,
      definition,
      notes: String(input?.notes ?? ''),
      visibility: 'private',
    })
    .select('id')
    .single()
  if (error) return `Could not create the term: ${error.message}`
  let note = ''
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, true)
    if (col) {
      await db.from('collection_terminology').upsert(
        { collection_id: col.id, term_id: data.id, added_by: userId },
        { onConflict: 'collection_id,term_id', ignoreDuplicates: true },
      )
      note = ` Filed into collection "${col.name}".`
    }
  }
  await logActivity(db, 'term.created', `Created term "${term}"`, { id: data.id, collection: ref || null }, userId)
  return `Created term "${term}" (id ${data.id}): ${definition.slice(0, 100)}${definition.length > 100 ? '...' : ''}.${note}`
}

async function listTerms(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Terminology is unavailable.'
  let query = db
    .from('terminology')
    .select('id, term, definition, notes')
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .order('term', { ascending: true })
    .limit(100)
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, userId, ref, false)
    if (!col) return `Collection "${ref}" not found.`
    const { data: members } = await db.from('collection_terminology').select('term_id').eq('collection_id', col.id)
    const ids = (members ?? []).map((m: { term_id: string }) => m.term_id)
    if (!ids.length) return `No terms in collection "${col.name}".`
    query = query.in('id', ids)
  }
  const search = typeof input?.search === 'string' ? input.search.trim().toLowerCase() : ''
  const { data } = await query
  if (!data || !data.length) return 'No terminology entries. Use create_term to add one.'
  let filtered = data as Array<{ id: string; term: string; definition: string; notes: string }>
  if (search) {
    filtered = filtered.filter((t) => t.term.toLowerCase().includes(search) || t.definition.toLowerCase().includes(search))
  }
  if (!filtered.length) return `No terms match "${search}".`
  return filtered
    .map((t) => `• ${t.term}: ${t.definition}${t.notes ? `\n  Notes: ${t.notes.slice(0, 150)}` : ''}\n  id: ${t.id}`)
    .join('\n')
}

async function updateTerm(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Terminology is unavailable.'
  const id = String(input?.id ?? '').trim()
  if (!id) return 'A term id is required.'
  const patch: Record<string, unknown> = {}
  if (typeof input?.term === 'string') patch.term = input.term.trim()
  if (typeof input?.definition === 'string') patch.definition = input.definition.trim()
  if (typeof input?.notes === 'string') patch.notes = input.notes.trim()
  if (!Object.keys(patch).length) return 'Nothing to update (pass term, definition, or notes).'
  const { data, error } = await db
    .from('terminology')
    .update(patch)
    .eq('id', id)
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .select('id')
    .maybeSingle()
  if (error) return `Could not update the term: ${error.message}`
  if (!data) return `Term ${id} not found (or not yours).`
  return `Updated term ${id}.`
}

async function deleteTerm(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Terminology is unavailable.'
  const id = String(input?.id ?? '').trim()
  if (!id) return 'A term id is required.'
  const { error } = await db
    .from('terminology')
    .delete()
    .eq('id', id)
    .eq('owner_id', userId)
  if (error) return `Could not delete the term: ${error.message}`
  return `Deleted term ${id}.`
}

async function addTermToCollection(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Terminology is unavailable.'
  const ref = String(input?.collection ?? '').trim()
  const termId = String(input?.term_id ?? '').trim()
  if (!ref || !termId) return 'Pass both a collection (name or id) and a term_id.'
  const col = await resolveCollection(db, userId, ref, true)
  if (!col) return `Could not resolve collection "${ref}".`
  const { error } = await db.from('collection_terminology').upsert(
    { collection_id: col.id, term_id: termId, added_by: userId },
    { onConflict: 'collection_id,term_id', ignoreDuplicates: true },
  )
  if (error) return `Could not add to the collection: ${error.message}`
  return `Added term ${termId} to collection "${col.name}".`
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
  const column = dateColumn(input?.date_field)
  const since = parseDateBound(input?.since, 'start')
  const until = parseDateBound(input?.until, 'end')
  if (since === 'invalid' || until === 'invalid') {
    return '`since` and `until` must be an ISO 8601 timestamp or a YYYY-MM-DD date.'
  }
  let query = db
    .from('links')
    .select('id, url, title, description, created_at, updated_at')
    .or(`owner_id.eq.${userId},visibility.eq.workspace`)
    .order(column, { ascending: false })
    .limit(100)
  if (since) query = query.gte(column, since)
  if (until) query = query.lte(column, until)
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
  if (!data || !data.length) {
    if (since || until) {
      const window = [since ? `from ${since}` : '', until ? `to ${until}` : ''].filter(Boolean).join(' ')
      return `No links ${column === 'updated_at' ? 'updated' : 'saved'} ${window}.`
    }
    return 'No saved links. Use save_link to add one.'
  }
  return formatLinkList(data as LinkRow[])
}

// Download a captured screenshot image and attach it to a link: the image is
// stored in the private `link-screenshots` bucket (member-readable) and the
// row's screenshot_path is set, which the Links page prefers over og:image.
async function setLinkScreenshot(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Links are unavailable.'
  const linkId = String(input?.link_id ?? '').trim()
  const imageUrl = String(input?.image_url ?? '').trim()
  if (!linkId || !/^https?:\/\//i.test(imageUrl)) return 'Pass a link_id and a full http(s) image_url.'

  const { data: link } = await db
    .from('links')
    .select('id, title, owner_id, visibility')
    .eq('id', linkId)
    .maybeSingle()
  if (!link || (link.owner_id !== userId && link.visibility !== 'workspace')) {
    return `Link ${linkId} not found (or not yours).`
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    const res = await fetch(imageUrl, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return `Could not download the image (status ${res.status}).`
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!mime.startsWith('image/')) return `That URL is not an image (content-type ${mime || 'unknown'}).`
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength > 8_000_000) return 'That image is too large (max 8MB).'

    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg'
    const path = `${link.owner_id}/${link.id}.${ext}`
    const { error: upErr } = await db.storage
      .from('link-screenshots')
      .upload(path, bytes, { contentType: mime, upsert: true })
    if (upErr) return `Could not store the screenshot: ${upErr.message}`

    const { error } = await db.from('links').update({ screenshot_path: path }).eq('id', link.id)
    if (error) return `Stored the image but could not update the link: ${error.message}`
    await logActivity(db, 'link.screenshot', `Attached a screenshot to "${link.title}"`, { id: link.id, path }, userId)
    return `Screenshot attached to "${link.title}" — the Links page now shows it as the preview.`
  } catch (err) {
    return `Screenshot failed: ${err instanceof Error ? err.message : 'error'}`
  }
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

// Resolve a skill by id or exact name, scoped to the caller's own skills plus
// any always-on prompt (mirrors the MCP server's resolveSkill).
async function resolveSkill(
  db: DB,
  userId: string,
  ref: string,
  archived: 'live' | 'archived' | 'any' = 'live',
): Promise<
  | {
    id: string
    name: string
    description: string | null
    instructions: string
    auto_apply: boolean
    is_builtin: boolean
    output_mode: string
    owner_id: string | null
  }
  | null
> {
  let q = db
    .from('skills')
    .select('id, name, description, instructions, auto_apply, is_builtin, output_mode, owner_id')
    .or(`owner_id.eq.${userId},auto_apply.eq.true`)
  if (archived === 'live') q = q.is('deleted_at', null)
  else if (archived === 'archived') q = q.not('deleted_at', 'is', null)
  q = isArtifactId(ref) ? q.eq('id', ref) : q.ilike('name', ref)
  const { data } = await q.order('updated_at', { ascending: false }).limit(1)
  // deno-lint-ignore no-explicit-any
  return (data?.[0] as any) ?? null
}

async function createSkill(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Skills are unavailable.'
  const name = String(input?.name ?? '').trim()
  if (!name) return 'A skill name is required.'
  const instructions = String(input?.instructions ?? '').trim()
  if (!instructions) return 'Skill instructions are required.'
  const wantAlwaysOn = input?.always_on === true
  if (wantAlwaysOn && !(await isAdmin(db, userId))) return 'Only admins can create always-on prompts.'
  const outputMode = input?.output_mode === 'reply' ? 'reply' : 'artifact'
  const { data, error } = await db
    .from('skills')
    .insert({
      owner_id: userId,
      name,
      description: input?.description != null ? String(input.description) : null,
      instructions,
      auto_apply: wantAlwaysOn,
      output_mode: outputMode,
    })
    .select('id')
    .single()
  if (error) return `Could not create the skill: ${error.message}`
  await logActivity(db, 'skill.created', `Created ${wantAlwaysOn ? 'always-on prompt' : 'skill'} "${name}"`, { id: data.id }, userId)
  return `Created ${wantAlwaysOn ? 'always-on prompt' : 'on-demand skill'} "${name}" (id ${data.id}).`
}

async function listSkills(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Skills are unavailable.'
  const limit = clampLimit(input?.limit, 50, 200)
  let q = db
    .from('skills')
    .select('id, name, description, auto_apply, is_builtin, output_mode, owner_id')
    .or(`owner_id.eq.${userId},auto_apply.eq.true`)
    .order('auto_apply', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (input?.always_on === true) q = q.eq('auto_apply', true)
  else if (input?.always_on === false) q = q.eq('auto_apply', false)
  // archived:true = the recovery area (only archived rows); else only live ones.
  q = input?.archived === true ? q.not('deleted_at', 'is', null) : q.is('deleted_at', null)
  const query = typeof input?.query === 'string' ? input.query.trim() : ''
  if (query) q = q.or(`name.ilike.%${query}%,description.ilike.%${query}%`)
  const { data, error } = await q
  if (error) return `Could not list skills: ${error.message}`
  const rows = (data ?? []) as Array<{ id: string; name: string; description: string | null; auto_apply: boolean; is_builtin: boolean }>
  if (!rows.length) return 'No skills or prompts match. Use create_skill to make one.'
  return rows
    .map((s) =>
      `• ${s.name} (${s.id}) [${s.auto_apply ? 'always-on prompt' : 'on-demand skill'}${s.is_builtin ? ', built-in' : ''}]${
        s.description ? ` — ${s.description}` : ''
      }`
    )
    .join('\n')
}

async function getSkill(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Skills are unavailable.'
  const ref = String(input?.skill ?? '').trim()
  if (!ref) return 'get_skill needs a skill id or exact name.'
  const skill = await resolveSkill(db, userId, ref)
  if (!skill) return `No skill or prompt matches "${ref}".`
  return [
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `mode: ${skill.auto_apply ? 'always-on prompt' : 'on-demand skill'}${skill.is_builtin ? ' (built-in)' : ''}`,
    `output_mode: ${skill.output_mode}`,
    `description: ${skill.description ?? '(none)'}`,
    `instructions:`,
    skill.instructions ?? '',
  ].join('\n')
}

async function updateSkill(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Skills are unavailable.'
  const ref = String(input?.skill ?? '').trim()
  if (!ref) return 'update_skill needs a skill id or exact name.'
  const skill = await resolveSkill(db, userId, ref)
  if (!skill) return `No skill or prompt matches "${ref}".`
  const wantAlwaysOn = typeof input?.always_on === 'boolean' ? input.always_on : skill.auto_apply
  // Always-on prompts (and toggling a skill onto/off always-on) are admin-only;
  // a resolved non-always-on skill is guaranteed owner-owned by resolveSkill.
  if ((skill.auto_apply || wantAlwaysOn) && !(await isAdmin(db, userId))) {
    return 'Only admins can edit or create always-on prompts.'
  }
  const patch: Record<string, unknown> = {}
  if (typeof input?.name === 'string' && input.name.trim()) patch.name = input.name.trim()
  if (typeof input?.description === 'string') patch.description = input.description
  if (typeof input?.instructions === 'string') patch.instructions = input.instructions
  if (input?.output_mode === 'artifact' || input?.output_mode === 'reply') patch.output_mode = input.output_mode
  if (typeof input?.always_on === 'boolean') patch.auto_apply = input.always_on
  if (!Object.keys(patch).length) {
    return 'Nothing to update — pass name, description, instructions, output_mode, and/or always_on.'
  }
  const { error } = await db.from('skills').update(patch).eq('id', skill.id)
  if (error) return `Could not update the skill: ${error.message}`
  return `Updated ${wantAlwaysOn ? 'always-on prompt' : 'on-demand skill'} "${(patch.name as string) ?? skill.name}" (id ${skill.id}).`
}

// Archive (soft delete) by default so a skill/prompt is recoverable; permanent
// removes the row for good. Built-ins are never deletable; always-on prompts
// are admin-gated (both archive and permanent).
async function deleteSkill(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Skills are unavailable.'
  const ref = String(input?.skill ?? '').trim()
  if (!ref) return 'delete_skill needs a skill id or exact name.'
  const permanent = input?.permanent === true
  const skill = await resolveSkill(db, userId, ref, 'any')
  if (!skill) return `No skill or prompt matches "${ref}".`
  if (skill.is_builtin) return `"${skill.name}" is a built-in prompt and can't be deleted (edit it with update_skill instead).`
  if (skill.auto_apply && !(await isAdmin(db, userId))) return 'Only admins can delete always-on prompts.'
  const kind = skill.auto_apply ? 'always-on prompt' : 'on-demand skill'
  if (permanent) {
    const { error } = await db.from('skills').delete().eq('id', skill.id)
    if (error) return `Could not delete the skill: ${error.message}`
    return `Permanently deleted ${kind} "${skill.name}". This cannot be undone.`
  }
  const { error } = await db.from('skills').update({ deleted_at: new Date().toISOString() }).eq('id', skill.id)
  if (error) return `Could not archive the skill: ${error.message}`
  return `Archived ${kind} "${skill.name}". It's hidden but recoverable with restore_skill (or delete it for good with permanent:true).`
}

async function restoreSkill(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Skills are unavailable.'
  const ref = String(input?.skill ?? '').trim()
  if (!ref) return 'restore_skill needs a skill id or exact name.'
  const skill = await resolveSkill(db, userId, ref, 'archived')
  if (!skill) return `No archived skill or prompt matches "${ref}". Use list_skills with archived:true to see the recovery area.`
  if (skill.auto_apply && !(await isAdmin(db, userId))) return 'Only admins can restore always-on prompts.'
  const { error } = await db.from('skills').update({ deleted_at: null }).eq('id', skill.id)
  if (error) return `Could not restore the skill: ${error.message}`
  return `Restored ${skill.auto_apply ? 'always-on prompt' : 'on-demand skill'} "${skill.name}". It's active again.`
}

async function isAdmin(db: DB, userId: string): Promise<boolean> {
  const { data } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  return !!data?.is_admin
}
