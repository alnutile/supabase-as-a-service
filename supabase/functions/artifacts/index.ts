// Supabase Edge Function: `artifacts` (PUBLIC — verify_jwt=false).
//
// A small, plain-REST CRUD API around artifacts so you can push content in from
// anywhere — a script, a Zap, another app, a cron job — without speaking MCP or
// holding a Supabase session. Auth is a bearer token: EITHER a per-user
// `mcp_tokens` token (the same one you mint in Settings → Connect Claude) OR a
// Supabase session JWT (verified in code via auth.getUser — see _shared/apiauth).
// Every call runs AS that token's owner and the function re-enforces ownership
// in code (it uses the service role, so RLS is not the gate here — the token →
// owner mapping is).
//
// Routes (base: /functions/v1/artifacts):
//   GET    /                       → list your artifacts (filter ?collection=, ?type=, ?q=, ?limit=, ?offset=, ?include=content)
//   POST   /                       → create one  { title, content, type?, language?, visibility?, collection?, collections? }
//   GET    /:id                    → read one (includes content + its collections)
//   PATCH  /:id  (or PUT)          → update fields you pass; collection(s) are added (not replaced)
//   DELETE /:id                    → delete one
//   GET    /  (no Authorization)   → human-readable HTML docs (so opening the URL in a browser explains itself)
//   GET    /docs                   → the same docs, always
//
// "Collection tag": pass `collection` (a name or id — created if missing) or
// `collections` (an array of them) on create/update to file the artifact into
// one or more collections — the same groups you chat with in the app.
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

const ARTIFACT_TYPES = ['markdown', 'code', 'html', 'text'] as const
const VISIBILITIES = ['private', 'workspace', 'unlisted', 'public'] as const

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

/** A short, URL-safe random slug for public share links (mirrors src/lib/util.ts). */
function makeSlug(len = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
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

// File an artifact into one or more collections (additive; created if missing).
// Returns the names actually filed into.
async function fileIntoCollections(
  db: DB,
  owner: string,
  artifactId: string,
  refs: string[],
): Promise<string[]> {
  const names: string[] = []
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.trim()) continue
    const col = await resolveCollection(db, owner, ref, true)
    if (!col) continue
    await db.from('collection_artifacts').upsert(
      { collection_id: col.id, artifact_id: artifactId, added_by: owner },
      { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
    )
    names.push(col.name)
  }
  return names
}

// Collect collection refs from a request body: accepts `collection` (string) and
// `collections` (array of strings), de-duped.
function collectionRefs(body: Record<string, unknown>): string[] {
  const out: string[] = []
  if (typeof body.collection === 'string') out.push(body.collection)
  if (Array.isArray(body.collections)) {
    for (const c of body.collections) if (typeof c === 'string') out.push(c)
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))]
}

// The only public URL this function can build is the `p` standalone page, which
// serves HTML artifacts only. For other types the caller has a `public_slug` and
// should link to `/share/a/<slug>` on the app origin (which this function can't know).
function standaloneUrl(row: Record<string, unknown>): string | null {
  const slug = row.public_slug as string | null
  return slug && row.type === 'html' ? `${SUPABASE_URL}/functions/v1/p/${slug}` : null
}

// Shape an artifact row for the API response. `withContent` controls whether the
// (potentially large) body is included.
function present(row: Record<string, unknown>, withContent: boolean) {
  const out: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    type: row.type,
    language: row.language ?? null,
    visibility: row.visibility,
    public_slug: row.public_slug ?? null,
    share_url: standaloneUrl(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
  if (withContent) out.content = row.content
  return out
}

// Fetch the collection names an artifact belongs to (that this owner can see).
async function artifactCollections(db: DB, owner: string, artifactId: string): Promise<string[]> {
  const { data } = await db
    .from('collection_artifacts')
    .select('collections!inner(id, name, owner_id, visibility)')
    .eq('artifact_id', artifactId)
  const rows = (data ?? []) as Array<{ collections: { name: string; owner_id: string; visibility: string } }>
  return rows
    .map((r) => r.collections)
    .filter((c) => c && (c.owner_id === owner || c.visibility === 'workspace'))
    .map((c) => c.name)
}

const DOCS = `Artifacts CRUD API
==================

A small REST API for pushing artifacts (docs / code / HTML / text) into this
workspace from anywhere, and tagging them into collections.

AUTH
  Send a bearer token in the Authorization header:
      Authorization: Bearer <token>
  The token is a personal connection token — create one in the app under
  Settings → Connect Claude (these are your "MCP" tokens). A Supabase session
  JWT works too (verified server-side). Every call runs as that token's owner;
  you only ever see and modify your own artifacts.

BASE URL
  ${SUPABASE_URL}/functions/v1/artifacts

ENDPOINTS
  GET    /artifacts                 List your artifacts (metadata only).
         ?collection=<name|id>        Only artifacts in this collection.
         ?type=markdown|code|html|text
         ?q=<text>                    Title contains (case-insensitive).
         ?include=content             Include the full content in each row.
         ?limit=<1-200>  ?offset=<n>  Paging (default limit 50).

  POST   /artifacts                 Create one. JSON body:
         { "title": "My doc",          (required)
           "content": "...",           (required)
           "type": "markdown",         (markdown|code|html|text, default markdown)
           "language": "ts",           (optional, for code)
           "visibility": "private",    (private|workspace|unlisted|public, default private)
           "collection": "Blog",       (optional name or id — created if missing)
           "collections": ["Blog","Q3"] (optional list, same rules) }

  GET    /artifacts/:id            Read one, including content and its collections.

  PATCH  /artifacts/:id  (or PUT)  Update only the fields you send. Passing
                                   collection / collections ADDS the artifact to
                                   them (existing tags are kept, not replaced).

  DELETE /artifacts/:id            Delete one.

NOTES
  • Visibility options: "private" (only you), "workspace" (team members),
    "unlisted" (anyone with link), "public" (anyone with link, discoverable).
    Only "unlisted" and "public" generate a public_slug for external sharing.
    HTML artifacts also get a share_url (a standalone page). For other types,
    link to https://<app-origin>/share/a/<public_slug>.
  • A collection is a named group you can chat with in the app. Reference it by
    name (created automatically if it doesn't exist yet) or by id.

EXAMPLES
  # Create a markdown artifact and tag it into "Blog"
  curl -X POST "${SUPABASE_URL}/functions/v1/artifacts" \\
    -H "Authorization: Bearer $TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"title":"Hello","content":"# Hi","type":"markdown","collection":"Blog"}'

  # List artifacts in a collection
  curl "${SUPABASE_URL}/functions/v1/artifacts?collection=Blog" \\
    -H "Authorization: Bearer $TOKEN"

  # Update content and make it public
  curl -X PATCH "${SUPABASE_URL}/functions/v1/artifacts/<id>" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"content":"# Updated","visibility":"public"}'

  # Delete
  curl -X DELETE "${SUPABASE_URL}/functions/v1/artifacts/<id>" \\
    -H "Authorization: Bearer $TOKEN"
`

function docsResponse() {
  return new Response(DOCS, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

// --- handlers ---------------------------------------------------------------

async function handleList(db: DB, owner: string, url: URL) {
  const include = url.searchParams.get('include') === 'content'
  const type = url.searchParams.get('type')
  const q = url.searchParams.get('q')
  const collection = url.searchParams.get('collection')
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0)

  // Optional collection filter → resolve to id, then to the member artifact ids.
  let onlyIds: string[] | null = null
  if (collection) {
    const col = await resolveCollection(db, owner, collection, false)
    if (!col) return json({ artifacts: [], count: 0 })
    const { data: members } = await db
      .from('collection_artifacts')
      .select('artifact_id')
      .eq('collection_id', col.id)
    onlyIds = (members ?? []).map((m) => m.artifact_id as string)
    if (!onlyIds.length) return json({ artifacts: [], count: 0 })
  }

  let query = db
    .from('artifacts')
    .select('id, title, type, language, visibility, public_slug, content, created_at, updated_at')
    .eq('owner_id', owner)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (onlyIds) query = query.in('id', onlyIds)
  if (type && (ARTIFACT_TYPES as readonly string[]).includes(type)) query = query.eq('type', type)
  if (q) query = query.ilike('title', `%${q}%`)

  const { data, error } = await query
  if (error) return err(error.message, 500)
  return json({ artifacts: (data ?? []).map((r) => present(r, include)), count: (data ?? []).length })
}

async function handleGet(db: DB, owner: string, id: string) {
  const { data, error } = await db
    .from('artifacts')
    .select('id, title, type, language, visibility, public_slug, content, created_at, updated_at')
    .eq('id', id)
    .eq('owner_id', owner)
    .maybeSingle()
  if (error) return err(error.message, 500)
  if (!data) return err('Artifact not found.', 404)
  const collections = await artifactCollections(db, owner, id)
  return json({ ...present(data, true), collections })
}

async function handleCreate(db: DB, owner: string, body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const content = typeof body.content === 'string' ? body.content : ''
  if (!title) return err('`title` is required.', 400)
  if (!content) return err('`content` is required.', 400)

  const type = (ARTIFACT_TYPES as readonly string[]).includes(body.type as string)
    ? (body.type as string)
    : 'markdown'
  const visibility = (VISIBILITIES as readonly string[]).includes(body.visibility as string)
    ? (body.visibility as string)
    : 'private'
  const language = typeof body.language === 'string' ? body.language : null
  // Only unlisted/public artifacts get a slug for external sharing; workspace is internal-only.
  const slug = visibility === 'unlisted' || visibility === 'public' ? makeSlug() : null

  const { data, error } = await db
    .from('artifacts')
    .insert({ owner_id: owner, title, content, type, language, visibility, public_slug: slug })
    .select('id, title, type, language, visibility, public_slug, content, created_at, updated_at')
    .single()
  if (error) return err(error.message, 500)

  const filed = await fileIntoCollections(db, owner, data.id as string, collectionRefs(body))
  return json({ ...present(data, true), collections: filed }, 201)
}

async function handleUpdate(db: DB, owner: string, id: string, body: Record<string, unknown>) {
  // Confirm ownership first (so we can 404 rather than silently no-op).
  const { data: existing } = await db
    .from('artifacts')
    .select('id, visibility, public_slug')
    .eq('id', id)
    .eq('owner_id', owner)
    .maybeSingle()
  if (!existing) return err('Artifact not found.', 404)

  const patch: Record<string, unknown> = {}
  if (typeof body.title === 'string') patch.title = body.title.trim()
  if (typeof body.content === 'string') patch.content = body.content
  if ((ARTIFACT_TYPES as readonly string[]).includes(body.type as string)) patch.type = body.type
  if (typeof body.language === 'string') patch.language = body.language
  if ((VISIBILITIES as readonly string[]).includes(body.visibility as string)) {
    patch.visibility = body.visibility
    // Mint a slug when going public/unlisted without one; workspace is internal-only.
    if ((body.visibility === 'unlisted' || body.visibility === 'public') && !existing.public_slug) {
      patch.public_slug = makeSlug()
    }
  }

  let data = existing as Record<string, unknown>
  if (Object.keys(patch).length) {
    const res = await db
      .from('artifacts')
      .update(patch)
      .eq('id', id)
      .eq('owner_id', owner)
      .select('id, title, type, language, visibility, public_slug, content, created_at, updated_at')
      .single()
    if (res.error) return err(res.error.message, 500)
    data = res.data
  } else {
    const res = await db
      .from('artifacts')
      .select('id, title, type, language, visibility, public_slug, content, created_at, updated_at')
      .eq('id', id)
      .single()
    data = res.data as Record<string, unknown>
  }

  const refs = collectionRefs(body)
  if (refs.length) await fileIntoCollections(db, owner, id, refs)
  const collections = await artifactCollections(db, owner, id)
  return json({ ...present(data, true), collections })
}

async function handleDelete(db: DB, owner: string, id: string) {
  const { data, error } = await db
    .from('artifacts')
    .delete()
    .eq('id', id)
    .eq('owner_id', owner)
    .select('id')
    .maybeSingle()
  if (error) return err(error.message, 500)
  if (!data) return err('Artifact not found.', 404)
  return json({ deleted: true, id })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)
  const base = parts.indexOf('artifacts')
  // The path segment after `/artifacts` (an id, or "docs"); undefined for the collection.
  const tail = base !== -1 ? parts[base + 1] : undefined

  // Docs: explicit /docs, or a bare GET with no Authorization (browser visit).
  const authHeader = req.headers.get('Authorization') ?? ''
  if (tail === 'docs' || (req.method === 'GET' && !tail && !authHeader)) return docsResponse()

  const token = parseBearer(authHeader)
  if (!token) return err('Missing bearer token. See GET /functions/v1/artifacts/docs.', 401)

  const db = admin()
  // Accept an mcp_tokens token OR a Supabase session JWT (shared with run-tool /
  // todos), so the same credential works across the token-gated APIs.
  const owner = await resolveApiUser(db, token)
  if (!owner) return err('Invalid token.', 401)

  // Parse a JSON body for write methods.
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
        if (tail) return err('POST to /artifacts (no id) to create.', 405)
        return await handleCreate(db, owner, body)
      case 'PATCH':
      case 'PUT':
        if (!tail) return err('PATCH/PUT requires an artifact id: /artifacts/:id.', 405)
        return await handleUpdate(db, owner, tail, body)
      case 'DELETE':
        if (!tail) return err('DELETE requires an artifact id: /artifacts/:id.', 405)
        return await handleDelete(db, owner, tail)
      default:
        return err('Method not allowed.', 405)
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Server error.', 500)
  }
})
