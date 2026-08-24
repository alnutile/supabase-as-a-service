// Builtin tools for the knowledge compiler — the in-app half of the compiled
// layer, shared by every agent loop (chat, scheduler, webhook, Slack, listeners)
// through `runBuiltin`, and re-exposed to an external Claude by the MCP server so
// both paths run one implementation and never drift.
//
// The tools split along the line the whole feature turns on:
//   READ    list_knowledge_pages / get_knowledge_page / get_change_brief /
//           list_conflicts — the maintained answer, and the evidence under it.
//   WRITE   compile_collection / update_knowledge_page — folding new material
//           into maintained understanding.
//   DECIDE  resolve_conflict / set_compile_policy — the human's calls. The
//           assistant may only record a decision the user actually made.
//
// These run with the service role (the loops do), so every handler re-enforces
// the private/workspace rule in code rather than leaning on RLS.
import {
  applyUpdateToContent,
  archiveScope,
  claimFingerprint,
  freshnessOf,
  normalizePolicy,
  pageKey,
  policyToJson,
  PAGE_KINDS,
  type CompiledPage,
  type PageKind,
} from './compiler.ts'

// The service-role client, untyped here on purpose: these tables are queried
// dynamically and the generated Database types are the frontend's contract.
// Same convention as collections.ts / orchestrator.ts.
// deno-lint-ignore no-explicit-any
type DB = any

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function clampLimit(v: unknown, def: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

function truncate(s: string, n: number): string {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n)}…` : t
}

async function isAdmin(db: DB, userId: string): Promise<boolean> {
  const { data } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  return Boolean(data?.is_admin)
}

/** Resolve a collection the caller can actually see. Never creates one. */
async function findCollection(
  db: DB,
  userId: string,
  ref: string,
): Promise<{ id: string; name: string; visibility: string } | null> {
  const r = String(ref ?? '').trim()
  if (!r) return null
  const { data } = await db.from('collections').select('id, name, owner_id, visibility')
  const rows = (data ?? []) as Array<{ id: string; name: string; owner_id: string; visibility: string }>
  const found = rows.find((c) => c.id === r || c.name.trim().toLowerCase() === r.toLowerCase())
  if (!found) return null
  if (found.owner_id === userId || found.visibility === 'workspace' || (await isAdmin(db, userId))) {
    return { id: found.id, name: found.name, visibility: found.visibility }
  }
  return null
}

/** Can the caller read this compiled page? (Service role bypasses RLS, so: in code.) */
function canRead(page: { owner_id: string; visibility: string }, userId: string, admin: boolean): boolean {
  return page.owner_id === userId || page.visibility === 'workspace' || admin
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

// ---------------------------------------------------------------------------
// compile_collection
// ---------------------------------------------------------------------------

/**
 * Run a compilation pass by calling the `compile` edge function with the
 * service-role key and naming the user it runs as — the same internal-trigger
 * shape loops and evals use. Synchronous on purpose: the assistant asked for a
 * pass, so it should get the change brief back in the same turn.
 */
export async function compileCollection(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Compilation is unavailable.'
  const ref = String(input?.collection ?? '').trim()
  if (!ref) return 'A collection name or id is required.'
  const col = await findCollection(db, userId, ref)
  if (!col) return `No collection you can access matches "${ref}".`

  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return 'The server is not configured to run compilation passes.'

  try {
    const res = await fetch(`${url}/functions/v1/compile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: col.id,
        triggered_by: userId,
        trigger: 'tool',
        since: typeof input?.since === 'string' && input.since.trim() ? input.since.trim() : undefined,
        dry_run: Boolean(input?.dry_run),
      }),
    })
    const text = await res.text()
    if (!res.ok) return `The compilation pass failed (HTTP ${res.status}): ${truncate(text, 300)}`
    const parsed = JSON.parse(text) as { brief?: string; runId?: string; counts?: Record<string, number> }
    if (!parsed.brief) return `The pass finished but produced no brief (run ${parsed.runId ?? 'unknown'}).`
    const c = parsed.counts ?? {}
    const headline = `Compiled "${col.name}" (run ${parsed.runId}). ${c.created ?? 0} page(s) created, ${
      c.updated ?? 0
    } updated, ${c.review ?? 0} held for review, ${c.conflicts ?? 0} conflict(s).`
    return `${headline}\n\n${parsed.brief}`
  } catch (err) {
    return `The compilation pass could not be started: ${err instanceof Error ? err.message : 'unknown error'}`
  }
}

// ---------------------------------------------------------------------------
// list_knowledge_pages
// ---------------------------------------------------------------------------

export async function listKnowledgePages(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Compiled knowledge is unavailable.'
  const admin = await isAdmin(db, userId)
  let query = db
    .from('knowledge_pages')
    .select('id, key, kind, title, summary, status, confidence, human_confirmed, updated_at, last_reviewed_at, owner_id, visibility, collection_id')
    .order('updated_at', { ascending: false })
    .limit(clampLimit(input?.limit, 50, 200))

  const ref = String(input?.collection ?? '').trim()
  let colName = ''
  if (ref) {
    const col = await findCollection(db, userId, ref)
    if (!col) return `No collection you can access matches "${ref}".`
    colName = col.name
    query = query.eq('collection_id', col.id)
  }
  // Archived pages are this feature's soft delete: excluded by default, and
  // reachable only by asking for the recovery area explicitly (archived:true).
  // An explicit `status` filter still wins, so status:'archived' keeps working.
  const scope = archiveScope(input)
  if (scope === 'archived') query = query.eq('status', 'archived')
  else if (!String(input?.status ?? '').trim()) query = query.neq('status', 'archived')

  const kind = String(input?.kind ?? '').trim().toLowerCase()
  if (kind) {
    if (!(PAGE_KINDS as readonly string[]).includes(kind)) {
      return `Unknown page kind "${kind}". Valid kinds: ${PAGE_KINDS.join(', ')}.`
    }
    query = query.eq('kind', kind)
  }
  const status = String(input?.status ?? '').trim().toLowerCase()
  if (status) query = query.eq('status', status)
  const contains = String(input?.title_contains ?? '').trim()
  if (contains) query = query.ilike('title', `%${contains}%`)

  const { data, error } = await query
  if (error) return `Could not list compiled pages: ${error.message}`
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((p) =>
    canRead(p as unknown as { owner_id: string; visibility: string }, userId, admin),
  )
  if (!rows.length) {
    if (scope === 'archived') return 'No archived compiled pages.'
    return colName
      ? `Nothing is compiled in "${colName}" yet. Run compile_collection to build its first pages from the sources already filed there.`
      : 'No compiled knowledge pages yet.'
  }

  const now = new Date()
  const lines = rows.map((p) => {
    const flags = [
      p.human_confirmed ? 'human-confirmed' : '',
      p.status !== 'compiled' ? String(p.status) : '',
      freshnessOf(
        {
          lastReviewedAt: (p.last_reviewed_at as string) ?? null,
          updatedAt: (p.updated_at as string) ?? '',
        } as CompiledPage,
        now,
      ) === 'stale'
        ? 'stale'
        : '',
    ]
      .filter(Boolean)
      .join(', ')
    const summary = p.summary ? ` — ${truncate(String(p.summary), 140)}` : ''
    return `- ${p.title} [${p.kind}] (id ${p.id}, key ${p.key}${flags ? `, ${flags}` : ''})${summary}`
  })
  const header = scope === 'archived'
    ? (colName ? `ARCHIVED compiled pages in "${colName}"` : 'ARCHIVED compiled knowledge pages')
    : (colName ? `Compiled pages in "${colName}"` : 'Compiled knowledge pages')
  return `${header} (${rows.length}):\n${lines.join('\n')}\n\nThese are the maintained answers. Use get_knowledge_page for one in full with its evidence.`
}

// ---------------------------------------------------------------------------
// get_knowledge_page
// ---------------------------------------------------------------------------

export async function getKnowledgePage(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Compiled knowledge is unavailable.'
  const admin = await isAdmin(db, userId)
  const id = String(input?.id ?? '').trim()
  const key = String(input?.key ?? '').trim()
  const title = String(input?.title ?? '').trim()
  if (!id && !key && !title) return 'An id, key, or exact title is required.'

  let query = db.from('knowledge_pages').select('*').limit(1)
  if (id && UUID_RE.test(id)) query = query.eq('id', id)
  else if (key) query = query.eq('key', pageKey(key))
  else query = query.ilike('title', title || id)

  const { data } = await query
  const page = ((data ?? []) as Array<Record<string, unknown>>)[0]
  if (!page) return 'No compiled page matches that.'
  if (!canRead(page as unknown as { owner_id: string; visibility: string }, userId, admin)) {
    return 'No compiled page matches that.'
  }

  const parts = [
    `# ${page.title} [${page.kind}]`,
    `status: ${page.status}${page.human_confirmed ? ' (human-confirmed)' : ''} · confidence: ${page.confidence} · updated ${
      String(page.updated_at ?? '').slice(0, 10)
    }${page.last_reviewed_at ? ` · last reviewed ${String(page.last_reviewed_at).slice(0, 10)}` : ' · never human-reviewed'}`,
  ]
  if (page.status === 'archived') {
    parts.push('⚠ This page is ARCHIVED. Someone removed it from maintained knowledge. Do not answer from it; treat it as history.')
  } else if (page.status === 'contradicted') {
    parts.push('⚠ This page is CONTRADICTED by newer evidence. Do not present it as current — say what is disputed.')
  } else if (page.status === 'needs-review') {
    parts.push('⚠ A proposed update to this page is awaiting review, so it may be out of date. Say so rather than asserting it as settled.')
  } else if (page.status === 'stale') {
    parts.push('⚠ This page is stale (not reviewed recently). Flag that when you use it.')
  }
  parts.push('', String(page.content ?? ''))

  if (input?.include_claims !== false) {
    const { data: claims } = await db
      .from('knowledge_claims')
      .select('statement, source_type, source_label, captured_at, confidence, status')
      .eq('page_id', page.id)
      .order('captured_at', { ascending: false })
      .limit(50)
    const rows = (claims ?? []) as Array<Record<string, unknown>>
    if (rows.length) {
      parts.push('', '## Evidence behind this page')
      parts.push(
        rows
          .map(
            (c) =>
              `- ${c.statement} — ${c.source_type}${c.source_label ? ` "${c.source_label}"` : ''}, captured ${
                String(c.captured_at ?? '').slice(0, 10)
              }${c.status !== 'active' ? ` (${c.status})` : ''}`,
          )
          .join('\n'),
      )
    }
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// update_knowledge_page
// ---------------------------------------------------------------------------

/**
 * Direct authoring of a compiled page. Deliberately narrower than what the
 * compiler itself can do: only `append` and `revise`, never a wholesale
 * supersede, and a human-confirmed page is only ever appended to — the same
 * invariant classifyUpdate enforces on the automatic path, so there is no way
 * to route around the trust boundary by calling the tool instead.
 */
export async function updateKnowledgePage(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Compiled knowledge is unavailable.'
  const body = String(input?.body ?? '').trim()
  if (!body) return 'A body is required.'
  const admin = await isAdmin(db, userId)

  const id = String(input?.id ?? '').trim()
  const key = String(input?.key ?? '').trim()
  const title = String(input?.title ?? '').trim()
  if (!id && !key && !title) return 'A title (or an existing id/key) is required.'

  let collectionId: string | null = null
  let collectionVisibility = 'private'
  const ref = String(input?.collection ?? '').trim()
  if (ref) {
    const col = await findCollection(db, userId, ref)
    if (!col) return `No collection you can access matches "${ref}".`
    collectionId = col.id
    collectionVisibility = col.visibility
  }

  // Find the existing page, if any.
  let existing: Record<string, unknown> | null = null
  {
    let q = db.from('knowledge_pages').select('*').limit(1)
    if (id && UUID_RE.test(id)) q = q.eq('id', id)
    else if (key) q = q.eq('key', pageKey(key))
    else q = q.eq('key', pageKey(title))
    if (!id && collectionId) q = q.eq('collection_id', collectionId)
    const { data } = await q
    existing = ((data ?? []) as Array<Record<string, unknown>>)[0] ?? null
  }
  if (existing && !canRead(existing as unknown as { owner_id: string; visibility: string }, userId, admin)) {
    return 'You do not have access to that compiled page.'
  }

  const rawOp = String(input?.op ?? 'append').trim().toLowerCase()
  const op = rawOp === 'revise' ? 'revise' : 'append'
  if (existing?.human_confirmed && op === 'revise') {
    return `"${existing.title}" is human-confirmed, so it is only appended to. Either append instead, or have the user unconfirm it first if the page genuinely needs rewriting.`
  }

  const kindRaw = String(input?.kind ?? '').trim().toLowerCase()
  const kind: PageKind = (PAGE_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as PageKind)
    : ((existing?.kind as PageKind) ?? 'concept')

  const labels = Array.isArray(input?.labels)
    ? (input.labels as unknown[]).map((l) => String(l ?? '').trim()).filter(Boolean).slice(0, 20)
    : null
  const confirmed = input?.confirmed === true
  const now = new Date()

  if (existing) {
    const page: CompiledPage = {
      id: existing.id as string,
      key: existing.key as string,
      kind,
      title: (existing.title as string) ?? title,
      content: (existing.content as string) ?? '',
      status: existing.status as CompiledPage['status'],
      confidence: Number(existing.confidence ?? 0.5),
      humanConfirmed: Boolean(existing.human_confirmed),
      labels: (existing.labels as string[]) ?? [],
      lastReviewedAt: (existing.last_reviewed_at as string) ?? null,
      updatedAt: (existing.updated_at as string) ?? '',
    }
    const content = applyUpdateToContent(page, {
      op,
      pageKey: page.key,
      kind,
      title: page.title,
      body,
      reason: 'authored directly',
      confidence: 0.8,
      conflictsWith: [],
      sourceIds: [],
    }, now)

    const patch: Record<string, unknown> = { content, status: 'compiled', updated_at: now.toISOString() }
    if (labels) patch.labels = labels
    if (typeof input?.summary === 'string') patch.summary = input.summary.trim()
    if (confirmed) {
      patch.human_confirmed = true
      patch.status = 'confirmed'
      patch.last_reviewed_at = now.toISOString()
    }
    const { error } = await db.from('knowledge_pages').update(patch).eq('id', page.id)
    if (error) return `Could not update the page: ${error.message}`
    if (existing.artifact_id) await db.from('artifacts').update({ content }).eq('id', existing.artifact_id as string)
    await logActivity(db, 'knowledge.page_updated', `Updated compiled page "${page.title}"`, { id: page.id, op }, userId)
    return `Updated compiled page "${page.title}" (${op}, id ${page.id}).${confirmed ? ' Marked human-confirmed.' : ''}`
  }

  const finalTitle = title || key
  if (!finalTitle) return 'A title is required to create a new compiled page.'
  const { data: created, error } = await db
    .from('knowledge_pages')
    .insert({
      owner_id: userId,
      collection_id: collectionId,
      key: pageKey(key || finalTitle),
      kind,
      title: finalTitle,
      summary: String(input?.summary ?? '').trim(),
      content: body,
      status: confirmed ? 'confirmed' : 'compiled',
      human_confirmed: confirmed,
      last_reviewed_at: confirmed ? now.toISOString() : null,
      labels: labels ?? [],
      confidence: 0.8,
      visibility: String(input?.visibility ?? '') === 'workspace'
        ? 'workspace'
        : collectionVisibility === 'workspace'
          ? 'workspace'
          : 'private',
    })
    .select('id, title')
    .single()
  if (error) return `Could not create the page: ${error.message}`
  await logActivity(db, 'knowledge.page_created', `Created compiled page "${created.title}"`, { id: created.id, kind }, userId)
  return `Created compiled page "${created.title}" [${kind}] (id ${created.id}).`
}

// ---------------------------------------------------------------------------
// list_conflicts
// ---------------------------------------------------------------------------

export async function listConflicts(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Conflict review is unavailable.'
  const admin = await isAdmin(db, userId)
  const status = ['open', 'resolved', 'dismissed'].includes(String(input?.status ?? ''))
    ? String(input?.status)
    : 'open'

  let query = db
    .from('knowledge_conflicts')
    .select('id, title, existing_text, incoming_text, impact, suggested_action, severity, category, status, created_at, owner_id, collection_id')
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(clampLimit(input?.limit, 25, 100))

  const ref = String(input?.collection ?? '').trim()
  if (ref) {
    const col = await findCollection(db, userId, ref)
    if (!col) return `No collection you can access matches "${ref}".`
    query = query.eq('collection_id', col.id)
  }

  const { data, error } = await query
  if (error) return `Could not list conflicts: ${error.message}`
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((c) => c.owner_id === userId || admin)
  if (!rows.length) return status === 'open' ? 'No open conflicts — compiled knowledge is consistent.' : `No ${status} conflicts.`

  const lines = rows.map((c) => {
    const head = c.category === 'held'
      ? `HELD FOR REVIEW (${c.severity}) — ${c.title} (id ${c.id})`
      : `CONFLICT (${c.severity}) — ${c.title} (id ${c.id})`
    return [
      head,
      `  new source: ${truncate(String(c.incoming_text ?? ''), 300)}`,
      `  existing:   ${truncate(String(c.existing_text ?? ''), 300)}`,
      c.impact ? `  impact:     ${truncate(String(c.impact), 300)}` : '',
      c.suggested_action ? `  decide:     ${truncate(String(c.suggested_action), 300)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  return `${rows.length} ${status} item(s) awaiting a decision:\n\n${lines.join('\n\n')}\n\nPresent these to the user and let THEM choose which source is current. Only call resolve_conflict once they have decided.`
}

// ---------------------------------------------------------------------------
// resolve_conflict
// ---------------------------------------------------------------------------

/**
 * Record a human's decision. `apply` writes the held/incoming text onto the
 * page and marks it human-confirmed — because a person just looked at it, which
 * is exactly what confirmation means.
 */
export async function resolveConflict(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Conflict review is unavailable.'
  const id = String(input?.id ?? '').trim()
  if (!UUID_RE.test(id)) return 'A conflict id is required.'
  const decision = String(input?.decision ?? '').trim().toLowerCase()
  if (!['apply', 'keep', 'dismiss'].includes(decision)) {
    return 'decision must be "apply" (write the new text), "keep" (leave the page as it is), or "dismiss".'
  }

  const { data: conflict } = await db.from('knowledge_conflicts').select('*').eq('id', id).maybeSingle()
  if (!conflict) return 'No such conflict.'
  const admin = await isAdmin(db, userId)
  if (conflict.owner_id !== userId && !admin) return 'You do not have access to that conflict.'
  if (conflict.status !== 'open') return `That conflict is already ${conflict.status}.`

  const now = new Date()
  const note = String(input?.note ?? '').trim()
  let applied = ''

  if (decision === 'apply') {
    const proposed = (conflict.proposed ?? null) as Record<string, unknown> | null
    const bodyText = String(proposed?.body ?? conflict.incoming_text ?? '').trim()
    if (!bodyText) return 'There is nothing to apply on this conflict.'
    if (conflict.page_id) {
      const { data: page } = await db.from('knowledge_pages').select('*').eq('id', conflict.page_id).maybeSingle()
      if (!page) return 'The page this conflict refers to no longer exists.'
      const op = String(proposed?.op ?? 'revise') === 'append' ? 'append' : 'revise'
      const content = applyUpdateToContent(
        {
          id: page.id,
          key: page.key,
          kind: page.kind,
          title: page.title,
          content: page.content ?? '',
          status: page.status,
          confidence: Number(page.confidence ?? 0.5),
          humanConfirmed: Boolean(page.human_confirmed),
          labels: page.labels ?? [],
          lastReviewedAt: page.last_reviewed_at ?? null,
          updatedAt: page.updated_at ?? '',
        },
        {
          op,
          pageKey: page.key,
          kind: page.kind,
          title: page.title,
          body: bodyText,
          reason: 'human-approved',
          confidence: 0.9,
          conflictsWith: [],
          sourceIds: [],
        },
        now,
      )
      await db
        .from('knowledge_pages')
        .update({
          content,
          // A human just read this and said it is right — that IS confirmation.
          status: 'confirmed',
          human_confirmed: true,
          last_reviewed_at: now.toISOString(),
        })
        .eq('id', page.id)
      if (page.artifact_id) await db.from('artifacts').update({ content }).eq('id', page.artifact_id)
      applied = ` "${page.title}" now reflects the new source and is marked human-confirmed.`
    } else {
      const { data: fresh } = await db
        .from('knowledge_pages')
        .insert({
          owner_id: userId,
          collection_id: conflict.collection_id,
          key: pageKey(String(proposed?.page_key ?? conflict.title)),
          kind: (PAGE_KINDS as readonly string[]).includes(String(proposed?.kind))
            ? String(proposed?.kind)
            : 'concept',
          title: String(proposed?.title ?? conflict.title),
          content: bodyText,
          status: 'confirmed',
          human_confirmed: true,
          last_reviewed_at: now.toISOString(),
          confidence: 0.9,
        })
        .select('id, title')
        .maybeSingle()
      applied = fresh ? ` Created "${fresh.title}" from the approved text.` : ''
    }
  } else if (decision === 'keep' && conflict.page_id) {
    // The existing page won: clear the disputed flag and stamp the review, so
    // it stops nagging and its freshness clock restarts from a human's look.
    await db
      .from('knowledge_pages')
      .update({ status: 'confirmed', human_confirmed: true, last_reviewed_at: now.toISOString() })
      .eq('id', conflict.page_id)
    applied = ' The existing page was kept and marked human-confirmed.'
  }

  await db
    .from('knowledge_conflicts')
    .update({
      status: decision === 'dismiss' ? 'dismissed' : 'resolved',
      resolution: [decision, note].filter(Boolean).join(': '),
      resolved_by: userId,
      resolved_at: now.toISOString(),
    })
    .eq('id', id)

  await logActivity(db, 'knowledge.conflict_resolved', `Resolved conflict "${conflict.title}" (${decision})`, { id, decision }, userId)
  return `Recorded the decision "${decision}" on "${conflict.title}".${applied}`
}

// ---------------------------------------------------------------------------
// get_change_brief
// ---------------------------------------------------------------------------

export async function getChangeBrief(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Change briefs are unavailable.'
  const admin = await isAdmin(db, userId)
  const runId = String(input?.run_id ?? '').trim()

  let query = db
    .from('compile_runs')
    .select('id, collection_id, status, brief, counts, sources_seen, started_at, finished_at, error, owner_id')
    .order('started_at', { ascending: false })
    .limit(1)
  if (runId && UUID_RE.test(runId)) query = query.eq('id', runId)
  else {
    const ref = String(input?.collection ?? '').trim()
    if (ref) {
      const col = await findCollection(db, userId, ref)
      if (!col) return `No collection you can access matches "${ref}".`
      query = query.eq('collection_id', col.id)
    }
    query = query.eq('status', 'ok')
  }

  const { data } = await query
  const run = ((data ?? []) as Array<Record<string, unknown>>)[0]
  if (!run) return 'No compilation pass has run yet.'
  if (run.owner_id !== userId && !admin) return 'You do not have access to that run.'
  if (run.status === 'error') return `That pass failed: ${run.error ?? 'unknown error'}`
  if (run.status === 'running') return 'That pass is still running — check back in a moment.'
  return String(run.brief ?? '') || 'That pass produced no brief.'
}

// ---------------------------------------------------------------------------
// set_compile_policy
// ---------------------------------------------------------------------------

/**
 * Edit a collection's trust boundary. Everything goes through normalizePolicy,
 * so an unknown source or page kind is DROPPED rather than trusted — the policy
 * is an allow-list, and a typo must never quietly widen what may be rewritten.
 */
export async function setCompilePolicy(
  db: DB | null,
  input: Record<string, unknown>,
  userId: string | null,
): Promise<string> {
  if (!db || !userId) return 'Compilation policies are unavailable.'
  const ref = String(input?.collection ?? '').trim()
  if (!ref) return 'A collection name or id is required.'
  const col = await findCollection(db, userId, ref)
  if (!col) return `No collection you can access matches "${ref}".`

  const { data: row } = await db
    .from('compile_policies')
    .select('policy')
    .eq('collection_id', col.id)
    .maybeSingle()
  const current = normalizePolicy(row?.policy ?? {})

  const merged = normalizePolicy({
    ...policyToJson(current),
    ...(input?.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input?.autonomy !== undefined ? { autonomy: input.autonomy } : {}),
    ...(input?.compile_sources !== undefined ? { compile_sources: input.compile_sources } : {}),
    ...(input?.maintain_kinds !== undefined ? { maintain_kinds: input.maintain_kinds } : {}),
    ...(input?.never_auto !== undefined ? { never_auto: input.never_auto } : {}),
    ...(input?.min_confidence !== undefined ? { min_confidence: input.min_confidence } : {}),
    ...(input?.stale_days !== undefined ? { stale_days: input.stale_days } : {}),
  })

  const { error } = await db.from('compile_policies').upsert(
    { collection_id: col.id, owner_id: userId, policy: policyToJson(merged) },
    { onConflict: 'collection_id' },
  )
  if (error) return `Could not save the policy: ${error.message}`
  await logActivity(db, 'knowledge.policy_set', `Set the compilation policy for "${col.name}"`, { collection_id: col.id, policy: policyToJson(merged) }, userId)

  return [
    `Compilation policy for "${col.name}":`,
    `- compilation: ${merged.enabled ? 'on' : 'off'}`,
    `- autonomy: ${merged.autonomy} (${
      merged.autonomy === 'suggest'
        ? 'nothing is written unattended'
        : merged.autonomy === 'guarded'
          ? 'new pages and additive appends apply; rewrites go to review'
          : 'rewrites apply too; wholesale replacement still needs a human'
    })`,
    `- compiles from: ${merged.compileSources.join(', ')}`,
    `- maintains: ${merged.maintainKinds.join(', ')}`,
    `- never auto-edited: ${merged.neverAuto.length ? merged.neverAuto.join(', ') : '(nothing marked)'}`,
    `- review below confidence: ${merged.minConfidence}`,
    `- stale after: ${merged.staleDays} days`,
  ].join('\n')
}

/** Claim fingerprint helper re-exported for the MCP server's ingest paths. */
export { claimFingerprint }
