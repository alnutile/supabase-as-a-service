// Supabase Edge Function: `github-webhook` (PUBLIC — verify_jwt=false).
//
// Ingests GitHub content into the workspace knowledge base. Two entry shapes:
//
//   1. GitHub webhook (token-gated):  POST /functions/v1/github-webhook/<token>
//      A repo's webhook posts `push` / `issues` / `pull_request` events here. We
//      resolve the source by token, verify GitHub's HMAC signature (if a secret
//      is set), then for a push fetch each changed doc/spec file's content and
//      STAGE it as a `documents` row (source='github'); for an issue/PR we stage
//      its title+body. Embedding is deferred to the `ingest` cron's EMBED phase
//      (resumable + compute-safe), so a big push doesn't blow the worker budget.
//
//   2. Manual backfill (JWT-gated):   POST /functions/v1/github-webhook
//      Body { action:'sync', source_id }. The signed-in OWNER triggers a one-off
//      walk of the repo's current tree, staging every matching file — so an
//      existing docs repo is searchable immediately, not only on the next push.
//
// Nothing about retrieval changes: github docs default to scope='workspace', so
// the existing RLS + match_document_chunks + `search_documents` tool already make
// them searchable by the whole team alongside PDFs and notes.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { stageDocument, removeDocumentByRef } from '../_shared/knowledge.ts'
import { fetchFile, fetchTree, fileRef, matchesAny, topicRef, verifySignature } from '../_shared/github.ts'

const MAX_FILES_PER_EVENT = 50 // bound the work (and GitHub API calls) per request
const MAX_TEXT = 200_000 // cap a single file/topic's text before chunking

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-github-event, x-hub-signature-256',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function extractToken(url: URL): string | null {
  const q = url.searchParams.get('token')
  if (q) return q.trim()
  const parts = url.pathname.split('/').filter(Boolean)
  const i = parts.indexOf('github-webhook')
  if (i !== -1 && parts[i + 1]) return parts[i + 1]
  const last = parts[parts.length - 1]
  return last && last !== 'github-webhook' ? last : null
}

// deno-lint-ignore no-explicit-any
type DB = any
interface Source {
  id: string
  owner_id: string
  repo: string
  branch: string
  include_globs: string[]
  ingest_issues: boolean
  scope: 'workspace' | 'private'
  secret: string | null
  pat_secret_id: string | null
}

async function logEvent(db: DB, sourceId: string, eventType: string, status: string, summary: string, detail?: unknown) {
  await db.from('github_events').insert({ source_id: sourceId, event_type: eventType, status, summary, detail: detail ?? null })
}

async function getPat(db: DB, src: Source): Promise<string | null> {
  if (!src.pat_secret_id) return null
  const { data } = await db.rpc('read_github_source_pat', { p_source_id: src.id })
  return typeof data === 'string' && data.length > 0 ? data : null
}

// Stage a batch of repo paths as documents. Returns counts.
async function stageFiles(db: DB, src: Source, pat: string | null, paths: string[]) {
  let staged = 0
  let skipped = 0
  for (const path of paths.slice(0, MAX_FILES_PER_EVENT)) {
    const text = await fetchFile(src.repo, path, src.branch, pat)
    if (!text || text.trim().length < 20) {
      skipped++
      continue
    }
    await stageDocument(db, {
      ownerId: src.owner_id,
      name: `${src.repo}/${path}`,
      text: text.slice(0, MAX_TEXT),
      source: 'github',
      sourceRef: fileRef(src.repo, path, src.branch),
      scope: src.scope,
    })
    staged++
  }
  return { staged, skipped }
}

// --- Handle a `push`: stage added/modified matching files, remove deleted ones. ---
// deno-lint-ignore no-explicit-any
async function handlePush(db: DB, src: Source, pat: string | null, payload: any) {
  const ref: string = payload?.ref ?? ''
  // Only the source's tracked branch.
  if (ref && ref !== `refs/heads/${src.branch}`) {
    await logEvent(db, src.id, 'push', 'skipped', `Ignored push to ${ref} (tracking ${src.branch})`)
    return json({ ok: true, skipped: 'other branch' })
  }
  const commits: Array<{ added?: string[]; modified?: string[]; removed?: string[] }> = Array.isArray(payload?.commits) ? payload.commits : []
  const changed = new Set<string>()
  const removed = new Set<string>()
  for (const c of commits) {
    for (const p of [...(c.added ?? []), ...(c.modified ?? [])]) changed.add(p)
    for (const p of c.removed ?? []) removed.add(p)
  }
  // A path both changed and removed across commits ends up changed (latest wins
  // for added/modified; if truly removed last, the fetch 404s and it's skipped).
  for (const p of changed) removed.delete(p)

  const toStage = [...changed].filter((p) => matchesAny(p, src.include_globs))
  const toRemove = [...removed].filter((p) => matchesAny(p, src.include_globs))

  for (const p of toRemove) await removeDocumentByRef(db, 'github', fileRef(src.repo, p, src.branch))
  const { staged, skipped } = await stageFiles(db, src, pat, toStage)

  await db.from('github_sources').update({ last_synced_at: new Date().toISOString() }).eq('id', src.id)
  const summary = `Push: staged ${staged} file(s), removed ${toRemove.length}, skipped ${skipped}`
  await logEvent(db, src.id, 'push', 'ok', summary, { staged, removed: toRemove.length, skipped })
  await db.from('activity_log').insert({
    type: 'github.synced',
    summary: `${src.repo}: ${summary}`,
    detail: { source_id: src.id, repo: src.repo, staged, removed: toRemove.length },
    actor_id: src.owner_id,
  })
  return json({ ok: true, staged, removed: toRemove.length, skipped })
}

// --- Handle an `issues` / `pull_request` / `issue_comment` event. ---
// deno-lint-ignore no-explicit-any
async function handleTopic(db: DB, src: Source, eventType: string, payload: any) {
  if (!src.ingest_issues) {
    await logEvent(db, src.id, eventType, 'skipped', 'Issue/PR ingestion is off for this source')
    return json({ ok: true, skipped: 'issues off' })
  }
  const isPr = eventType === 'pull_request'
  const obj = isPr ? payload?.pull_request : payload?.issue
  if (!obj?.number) {
    await logEvent(db, src.id, eventType, 'skipped', 'No issue/PR in payload')
    return json({ ok: true, skipped: 'no topic' })
  }
  const number: number = obj.number
  const title: string = obj.title ?? ''
  const body: string = obj.body ?? ''
  const kind = isPr ? 'pull' : 'issues'
  // Include the latest comment when this is a comment event, for context.
  const comment = eventType === 'issue_comment' && payload?.comment?.body
    ? `\n\n--- comment by ${payload.comment.user?.login ?? 'user'} ---\n${payload.comment.body}`
    : ''
  const text = `# ${title}\n\n${body}${comment}`.slice(0, MAX_TEXT)
  if (text.trim().length < 20) {
    await logEvent(db, src.id, eventType, 'skipped', `#${number} has no indexable text`)
    return json({ ok: true, skipped: 'empty' })
  }

  await stageDocument(db, {
    ownerId: src.owner_id,
    name: `${src.repo} ${isPr ? 'PR' : 'issue'} #${number}: ${title}`.slice(0, 200),
    text,
    source: 'github',
    sourceRef: topicRef(src.repo, kind, number),
    scope: src.scope,
  })
  await logEvent(db, src.id, eventType, 'ok', `Indexed ${isPr ? 'PR' : 'issue'} #${number}: ${title}`.slice(0, 200))
  return json({ ok: true, indexed: number })
}

// --- Manual backfill: walk the repo tree, stage every matching file. ---
async function handleSync(db: DB, src: Source) {
  const pat = await getPat(db, src)
  let tree: { paths: string[]; truncated: boolean }
  try {
    tree = await fetchTree(src.repo, src.branch, pat)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'tree fetch failed'
    await logEvent(db, src.id, 'sync', 'error', msg)
    return json({ error: msg }, 502)
  }
  const matching = tree.paths.filter((p) => matchesAny(p, src.include_globs))

  // Backfill prioritizes files not yet indexed so repeated "Sync now" runs make
  // forward progress on a big repo (pushes keep already-synced files current).
  const { data: have } = await db
    .from('documents')
    .select('source_ref')
    .eq('source', 'github')
    .like('source_ref', `${src.repo}:%@${src.branch}`)
  const indexed = new Set((have ?? []).map((r: { source_ref: string | null }) => r.source_ref))
  const pending = matching.filter((p) => !indexed.has(fileRef(src.repo, p, src.branch)))

  const { staged, skipped } = await stageFiles(db, src, pat, pending)
  await db.from('github_sources').update({ last_synced_at: new Date().toISOString() }).eq('id', src.id)
  const more = pending.length > MAX_FILES_PER_EVENT ? pending.length - MAX_FILES_PER_EVENT : 0
  const summary = `Sync: staged ${staged} file(s)${skipped ? `, skipped ${skipped}` : ''}${more ? `, ${more} more this run` : ''}${tree.truncated ? ' (repo tree truncated by GitHub)' : ''}`
  await logEvent(db, src.id, 'sync', 'ok', summary, { matched: matching.length, staged, skipped })
  await db.from('activity_log').insert({
    type: 'github.synced',
    summary: `${src.repo}: ${summary}`,
    detail: { source_id: src.id, repo: src.repo, staged },
    actor_id: src.owner_id,
  })
  return json({ ok: true, matched: matching.length, staged, skipped, truncated: tree.truncated, remaining: more })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500)
  const db = createClient(supabaseUrl, serviceKey)

  const url = new URL(req.url)
  const raw = await req.text()

  // --- Path A: manual backfill (JWT-authenticated owner, no URL token). ---
  const token = extractToken(url)
  if (!token) {
    let body: { action?: string; source_id?: string }
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return json({ error: 'invalid JSON' }, 400)
    }
    if (body.action !== 'sync' || !body.source_id) return json({ error: 'unauthorized' }, 401)

    // Identify the caller from their JWT and confirm ownership.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!jwt) return json({ error: 'unauthorized' }, 401)
    const userClient = createClient(supabaseUrl, anonKey ?? serviceKey)
    const { data: { user } } = await userClient.auth.getUser(jwt)
    if (!user) return json({ error: 'unauthorized' }, 401)

    const { data: src } = await db.from('github_sources').select('*').eq('id', body.source_id).maybeSingle()
    if (!src || src.owner_id !== user.id) return json({ error: 'not found' }, 404)
    if (!src.repo) return json({ error: 'Set a repo (owner/name) first' }, 400)
    return await handleSync(db, src as Source)
  }

  // --- Path B: GitHub webhook (token + HMAC). ---
  const { data: src } = await db.from('github_sources').select('*').eq('token', token).maybeSingle()
  if (!src || !src.is_active) return json({ error: 'unauthorized' }, 401)
  const source = src as Source

  // If a secret is configured, GitHub's signature is the real gate — reject
  // BEFORE logging an event (a bad signature can't spam the log).
  if (source.secret) {
    const ok = await verifySignature(source.secret, raw, req.headers.get('x-hub-signature-256'))
    if (!ok) return json({ error: 'bad signature' }, 401)
  }

  const event = req.headers.get('x-github-event') ?? ''
  if (event === 'ping') {
    await logEvent(db, source.id, 'ping', 'ok', 'Webhook connected')
    return json({ ok: true, pong: true })
  }

  // deno-lint-ignore no-explicit-any
  let payload: any
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }
  if (!source.repo) {
    // Learn the repo name from the first event if not set yet.
    const full = payload?.repository?.full_name
    if (full) {
      await db.from('github_sources').update({ repo: full }).eq('id', source.id)
      source.repo = full
    }
  }
  if (!source.repo) return json({ error: 'source has no repo configured' }, 400)

  const pat = await getPat(db, source)

  try {
    if (event === 'push') return await handlePush(db, source, pat, payload)
    if (event === 'issues' || event === 'pull_request' || event === 'issue_comment') {
      return await handleTopic(db, source, event, payload)
    }
    await logEvent(db, source.id, event || 'unknown', 'skipped', `Unhandled event: ${event || '(none)'}`)
    return json({ ok: true, skipped: event })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'ingest failed'
    await logEvent(db, source.id, event || 'unknown', 'error', msg)
    return json({ error: msg }, 500)
  }
})
