// Supabase Edge Function: `todos` (PUBLIC — verify_jwt=false).
//
// A small, plain-REST CRUD API around to-dos so you can capture/sync tasks from
// anywhere — a script, a Zap, another app, a cron job — without speaking MCP or
// holding a Supabase session. Auth is a bearer token: EITHER a per-user
// `mcp_tokens` token (the same one you mint in Settings → Connect Claude) OR a
// Supabase session JWT (verified in code via auth.getUser — see _shared/apiauth).
// Every call runs AS that token's owner and the function re-enforces ownership
// in code (it uses the service role, so RLS is not the gate here — the token →
// owner mapping is). Mirrors the `artifacts` function.
//
// Routes (base: /functions/v1/todos):
//   GET    /                       → list your to-dos (?collection=, ?status=open|done, ?q=, ?sort=position|due, ?limit=, ?offset=)
//   POST   /                       → create one  { title, notes?, due_date?, visibility?, collection?, collections? }
//   GET    /:id                    → read one (includes its collections)
//   PATCH  /:id  (or PUT)          → update fields you pass; collection(s) are added (not replaced)
//   DELETE /:id                    → delete one
//   GET    /  (no Authorization)   → plain-text docs (so opening the URL explains itself)
//   GET    /docs                   → the same docs, always
//
// "Collection tag": pass `collection` (a name or id — created if missing) or
// `collections` (an array) on create/update to file the to-do into one or more
// collections — the same groups you chat with in the app.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { parseBearer, resolveApiUser } from '../_shared/apiauth.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
}

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' }

const VISIBILITIES = ['private', 'workspace'] as const

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
}
type DB = ReturnType<typeof admin>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS })
}
function err(message: string, status: number, extra?: Record<string, unknown>) {
  return json({ error: message, ...extra }, status)
}

// Accept a YYYY-MM-DD date string (or null to clear); reject anything else.
function normalizeDue(v: unknown): string | null | undefined {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined
}

// Resolve a collection by id or name for this owner (their own + workspace-shared);
// optionally create it (owned by `owner`, private) when missing.
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

// File a to-do into one or more collections (additive; created if missing).
async function fileIntoCollections(db: DB, owner: string, todoId: string, refs: string[]): Promise<string[]> {
  const names: string[] = []
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.trim()) continue
    const col = await resolveCollection(db, owner, ref, true)
    if (!col) continue
    await db.from('collection_todos').upsert(
      { collection_id: col.id, todo_id: todoId, added_by: owner },
      { onConflict: 'collection_id,todo_id', ignoreDuplicates: true },
    )
    names.push(col.name)
  }
  return names
}

function collectionRefs(body: Record<string, unknown>): string[] {
  const out: string[] = []
  if (typeof body.collection === 'string') out.push(body.collection)
  if (Array.isArray(body.collections)) {
    for (const c of body.collections) if (typeof c === 'string') out.push(c)
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))]
}

function present(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes ?? '',
    due_date: row.due_date ?? null,
    done: row.done ?? false,
    completed_at: row.completed_at ?? null,
    position: row.position ?? 0,
    visibility: row.visibility,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// Fetch the collection names a to-do belongs to (that this owner can see).
async function todoCollections(db: DB, owner: string, todoId: string): Promise<string[]> {
  const { data } = await db
    .from('collection_todos')
    .select('collections!inner(id, name, owner_id, visibility)')
    .eq('todo_id', todoId)
  const rows = (data ?? []) as unknown as Array<{ collections: { name: string; owner_id: string; visibility: string } }>
  return rows
    .map((r) => r.collections)
    .filter((c) => c && (c.owner_id === owner || c.visibility === 'workspace'))
    .map((c) => c.name)
}

const SELECT_COLS = 'id, title, notes, due_date, done, completed_at, position, visibility, created_at, updated_at'

const DOCS = `To-dos CRUD API
===============

A small REST API for capturing and syncing to-dos (tasks) in this workspace from
anywhere, and tagging them into collections.

AUTH
  Send a bearer token in the Authorization header:
      Authorization: Bearer <token>
  The token is a personal connection token — create one in the app under
  Settings → Connect Claude (these are your "MCP" tokens). A Supabase session
  JWT works too (verified server-side). Every call runs as that token's owner;
  you only ever see and modify your own to-dos.

BASE URL
  ${SUPABASE_URL}/functions/v1/todos

ENDPOINTS
  GET    /todos                     List your to-dos.
         ?collection=<name|id>        Only to-dos in this collection.
         ?status=open|done            Filter by status.
         ?q=<text>                    Title contains (case-insensitive).
         ?sort=position|due           Order (default position = your manual order).
         ?limit=<1-200>  ?offset=<n>  Paging (default limit 100).

  POST   /todos                     Create one. JSON body:
         { "title": "Ship the thing",  (required)
           "notes": "...",             (optional)
           "due_date": "2026-07-01",   (optional, YYYY-MM-DD)
           "visibility": "private",    (private|workspace, default private)
           "collection": "Work",       (optional name or id — created if missing)
           "collections": ["Work","Q3"] (optional list, same rules) }

  GET    /todos/:id               Read one, including its collections.

  PATCH  /todos/:id  (or PUT)     Update only the fields you send. Pass done:true
                                  to complete it. Passing collection / collections
                                  ADDS the to-do to them (existing tags are kept).

  DELETE /todos/:id              Delete one.

NOTES
  • visibility is "private" (only you + admins) or "workspace" (the whole team can
    see and collaborate) — same model as collections.
  • A collection is a named group you can chat with in the app. Reference it by
    name (created automatically if it doesn't exist) or by id.

EXAMPLES
  # Create a to-do due next week and tag it into "Work"
  curl -X POST "${SUPABASE_URL}/functions/v1/todos" \\
    -H "Authorization: Bearer $TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"title":"Ship the thing","due_date":"2026-07-01","collection":"Work"}'

  # List open to-dos in a collection, by due date
  curl "${SUPABASE_URL}/functions/v1/todos?collection=Work&status=open&sort=due" \\
    -H "Authorization: Bearer $TOKEN"

  # Mark one done
  curl -X PATCH "${SUPABASE_URL}/functions/v1/todos/<id>" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"done":true}'

  # Delete
  curl -X DELETE "${SUPABASE_URL}/functions/v1/todos/<id>" \\
    -H "Authorization: Bearer $TOKEN"
`

function docsResponse() {
  return new Response(DOCS, { status: 200, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } })
}

// --- handlers ---------------------------------------------------------------

async function handleList(db: DB, owner: string, url: URL) {
  const status = url.searchParams.get('status')
  const q = url.searchParams.get('q')
  const collection = url.searchParams.get('collection')
  const sort = url.searchParams.get('sort') === 'due' ? 'due' : 'position'
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 200)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)

  let onlyIds: string[] | null = null
  if (collection) {
    const col = await resolveCollection(db, owner, collection, false)
    if (!col) return json({ todos: [], count: 0 })
    const { data: members } = await db.from('collection_todos').select('todo_id').eq('collection_id', col.id)
    onlyIds = (members ?? []).map((m) => m.todo_id as string)
    if (!onlyIds.length) return json({ todos: [], count: 0 })
  }

  let query = db.from('todos').select(SELECT_COLS).eq('owner_id', owner).range(offset, offset + limit - 1)
  if (sort === 'due') query = query.order('due_date', { ascending: true, nullsFirst: false })
  else query = query.order('position', { ascending: true }).order('created_at', { ascending: false })
  if (onlyIds) query = query.in('id', onlyIds)
  if (status === 'open') query = query.eq('done', false)
  else if (status === 'done') query = query.eq('done', true)
  if (q) query = query.ilike('title', `%${q}%`)

  const { data, error } = await query
  if (error) return err(error.message, 500)
  return json({ todos: (data ?? []).map(present), count: (data ?? []).length })
}

async function handleGet(db: DB, owner: string, id: string) {
  const { data, error } = await db.from('todos').select(SELECT_COLS).eq('id', id).eq('owner_id', owner).maybeSingle()
  if (error) return err(error.message, 500)
  if (!data) return err('To-do not found.', 404)
  const collections = await todoCollections(db, owner, id)
  return json({ ...present(data), collections })
}

async function handleCreate(db: DB, owner: string, body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return err('`title` is required.', 400)

  const due = normalizeDue(body.due_date)
  if (due === undefined && body.due_date !== undefined) return err('`due_date` must be YYYY-MM-DD or null.', 400)
  const visibility = (VISIBILITIES as readonly string[]).includes(body.visibility as string)
    ? (body.visibility as string)
    : 'private'
  const notes = typeof body.notes === 'string' ? body.notes : ''
  const done = body.done === true

  const insert: Record<string, unknown> = { owner_id: owner, title, notes, visibility, done }
  if (due !== undefined) insert.due_date = due
  if (done) insert.completed_at = new Date().toISOString()

  const { data, error } = await db.from('todos').insert(insert).select(SELECT_COLS).single()
  if (error) return err(error.message, 500)

  const filed = await fileIntoCollections(db, owner, data.id as string, collectionRefs(body))
  return json({ ...present(data), collections: filed }, 201)
}

async function handleUpdate(db: DB, owner: string, id: string, body: Record<string, unknown>) {
  const { data: existing } = await db.from('todos').select('id, done').eq('id', id).eq('owner_id', owner).maybeSingle()
  if (!existing) return err('To-do not found.', 404)

  const patch: Record<string, unknown> = {}
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim()
  if (typeof body.notes === 'string') patch.notes = body.notes
  if (body.due_date !== undefined) {
    const due = normalizeDue(body.due_date)
    if (due === undefined) return err('`due_date` must be YYYY-MM-DD or null.', 400)
    patch.due_date = due
  }
  if ((VISIBILITIES as readonly string[]).includes(body.visibility as string)) patch.visibility = body.visibility
  if (typeof body.done === 'boolean') {
    patch.done = body.done
    patch.completed_at = body.done ? new Date().toISOString() : null
  }
  if (typeof body.position === 'number') patch.position = body.position

  let data = existing as Record<string, unknown>
  if (Object.keys(patch).length) {
    const res = await db.from('todos').update(patch).eq('id', id).eq('owner_id', owner).select(SELECT_COLS).single()
    if (res.error) return err(res.error.message, 500)
    data = res.data
  } else {
    const res = await db.from('todos').select(SELECT_COLS).eq('id', id).single()
    data = res.data as Record<string, unknown>
  }

  const refs = collectionRefs(body)
  if (refs.length) await fileIntoCollections(db, owner, id, refs)
  const collections = await todoCollections(db, owner, id)
  return json({ ...present(data), collections })
}

async function handleDelete(db: DB, owner: string, id: string) {
  const { data, error } = await db.from('todos').delete().eq('id', id).eq('owner_id', owner).select('id').maybeSingle()
  if (error) return err(error.message, 500)
  if (!data) return err('To-do not found.', 404)
  return json({ deleted: true, id })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)
  const base = parts.indexOf('todos')
  const tail = base !== -1 ? parts[base + 1] : undefined

  const authHeader = req.headers.get('Authorization') ?? ''
  if (tail === 'docs' || (req.method === 'GET' && !tail && !authHeader)) return docsResponse()

  const token = parseBearer(authHeader)
  if (!token) return err('Missing bearer token. See GET /functions/v1/todos/docs.', 401)

  const db = admin()
  // Accept an mcp_tokens token OR a Supabase session JWT (shared with run-tool /
  // artifacts), so the same credential works across the token-gated APIs.
  const owner = await resolveApiUser(db, token)
  if (!owner) return err('Invalid token.', 401)

  let body: Record<string, unknown> = {}
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    try {
      const raw = await req.text()
      body = raw ? JSON.parse(raw) : {}
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return err('Body must be a JSON object.', 400)
    } catch {
      return err('Invalid JSON body.', 400)
    }
  }

  try {
    switch (req.method) {
      case 'GET':
        return tail ? await handleGet(db, owner, tail) : await handleList(db, owner, url)
      case 'POST':
        if (tail) return err('POST to /todos (no id) to create.', 405)
        return await handleCreate(db, owner, body)
      case 'PATCH':
      case 'PUT':
        if (!tail) return err('PATCH/PUT requires a to-do id: /todos/:id.', 405)
        return await handleUpdate(db, owner, tail, body)
      case 'DELETE':
        if (!tail) return err('DELETE requires a to-do id: /todos/:id.', 405)
        return await handleDelete(db, owner, tail)
      default:
        return err('Method not allowed.', 405)
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Server error.', 500)
  }
})
