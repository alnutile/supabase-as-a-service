// Supabase Edge Function: `compile` — the knowledge compilation loop.
//
// This is the I/O half of the compiler; every judgment call it makes lives in
// the pure, unit-tested `_shared/compiler.ts`. The pass is deliberately linear
// and inspectable:
//
//   Capture (already happened — files/links/messages landed in a collection)
//     -> Gather the sources added since the last pass
//     -> Extract claims, concepts, decisions in ONE model call
//     -> Match them against the collection's compiled pages
//     -> Update compiled knowledge, but only within the collection's TRUST BOUNDARY
//     -> Flag contradictions and stale entries for a human
//     -> Write a change brief
//
// Two properties matter more than anything else here:
//
//   1. It fails CLOSED. A model reply that doesn't parse compiles nothing. An
//      update the policy won't allow becomes a review item, never a silent write.
//   2. It never resolves a contradiction. When new evidence disagrees with a
//      compiled page, the page is left alone and a conflict is raised. Choosing
//      which source is current is the human's job, not the compiler's.
//
// Auth (verify_jwt=false, checked in code, mirroring run-tool): a Supabase
// session JWT or a personal `mcp_tokens` bearer, so the UI, scripts, agents and
// cron can all trigger a pass; the run then executes AS that user and every read
// re-enforces the private/workspace rule in code (the function holds the service
// role, so RLS is not doing that for us).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { parseBearer, resolveApiUser } from '../_shared/apiauth.ts'
import { resolveModel } from '../_shared/models.ts'
import { recordUsage } from '../_shared/usage.ts'
import { fileToText } from '../_shared/collections.ts'
import { currentTimeSection, resolveWorkspaceTimezone } from '../_shared/timezone.ts'
import { orComplete, reasoningParam, systemMsg } from '../_shared/openrouter.ts'
import {
  applyUpdateToContent,
  briefCounts,
  buildCompilerPrompt,
  claimFingerprint,
  classifyUpdate,
  DEFAULT_POLICY,
  dedupeClaims,
  formatChangeBrief,
  matchPage,
  normalizePolicy,
  pageKey,
  parseCompilerOutput,
  shouldFlagPendingReview,
  stalePageKeys,
  type CompiledPage,
  type CompilePolicy,
  type RawSource,
  type SourceKind,
} from '../_shared/compiler.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// deno-lint-ignore no-explicit-any
type DB = any

// A pass reads at most this many new sources, so one enormous import can't turn
// into a single unbounded (and unaffordable) model call. The remainder is
// reported in the brief and picked up by the next pass.
const MAX_SOURCES = 40
const SOURCE_BUDGET_CHARS = 90_000

/** The live checklist the Knowledge dashboard renders while a pass runs. */
const STEPS = [
  { key: 'policy', label: 'Read the compilation policy' },
  { key: 'gather', label: 'Gather new sources' },
  { key: 'extract', label: 'Extract claims and proposed updates' },
  { key: 'apply', label: 'Update compiled knowledge' },
  { key: 'flag', label: 'Flag conflicts and stale entries' },
  { key: 'brief', label: 'Write the change brief' },
] as const

type StepState = 'pending' | 'running' | 'done' | 'skipped'

function initialProgress() {
  return STEPS.map((s) => ({ key: s.key, label: s.label, state: 'pending' as StepState, note: '' }))
}

// ---------------------------------------------------------------------------
// Access — the function runs as the service role, so this is the gate
// ---------------------------------------------------------------------------

interface Collection {
  id: string
  name: string
  owner_id: string
  visibility: string
}

/** Resolve a collection by id or name and confirm the caller may read it. */
async function resolveCollection(db: DB, userId: string, ref: string): Promise<Collection | null> {
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)
  const query = db.from('collections').select('id, name, owner_id, visibility')
  const { data } = isId ? await query.eq('id', ref).maybeSingle() : await query.ilike('name', ref).maybeSingle()
  const col = data as Collection | null
  if (!col) return null
  if (col.owner_id === userId || col.visibility === 'workspace') return col
  const { data: prof } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  return prof?.is_admin ? col : null
}

// ---------------------------------------------------------------------------
// Gathering raw sources
// ---------------------------------------------------------------------------

/** Newer of "when it was filed into this collection" and "when it last changed". */
function enteredAt(joinCreated: string | null, itemUpdated: string | null): string {
  const a = Date.parse(joinCreated ?? '') || 0
  const b = Date.parse(itemUpdated ?? '') || 0
  return new Date(Math.max(a, b)).toISOString()
}

function isNewer(ts: string, since: string | null): boolean {
  if (!since) return true
  return Date.parse(ts) > Date.parse(since)
}

/**
 * Collect the collection's raw material that is new since the last pass, honoring
 * the policy's source allow-list. Each item is re-checked against the caller's
 * visibility, since we hold the service role here.
 */
async function gatherSources(
  db: DB,
  collection: Collection,
  userId: string,
  policy: CompilePolicy,
  since: string | null,
): Promise<{ sources: RawSource[]; truncated: number }> {
  const allow = new Set<SourceKind>(policy.compileSources)
  const out: RawSource[] = []

  const joinRows = async (table: string, col: string) => {
    const { data } = await db.from(table).select(`${col}, created_at`).eq('collection_id', collection.id)
    return (data ?? []) as Array<Record<string, string>>
  }

  // --- artifacts (and meeting notes, which are artifacts carrying a marker) ---
  if (allow.has('artifact') || allow.has('meeting')) {
    const rows = await joinRows('collection_artifacts', 'artifact_id')
    const ids = rows.map((r) => r.artifact_id)
    if (ids.length) {
      const { data: arts } = await db
        .from('artifacts')
        .select('id, title, type, content, owner_id, visibility, updated_at, data')
        .in('id', ids)
        .is('deleted_at', null)
      // A compiled page's own artifact mirror must never be re-ingested as a
      // source: the compiler would then compile its own output, and every pass
      // would amplify whatever the last one wrote.
      const { data: mirrors } = await db
        .from('knowledge_pages')
        .select('artifact_id')
        .not('artifact_id', 'is', null)
      const mirrorIds = new Set((mirrors ?? []).map((m: { artifact_id: string }) => m.artifact_id))
      for (const a of (arts ?? []) as Array<Record<string, unknown>>) {
        if (mirrorIds.has(a.id as string)) continue
        if (a.owner_id !== userId && a.visibility === 'private') continue
        const isMeeting = String((a.data as Record<string, unknown> | null)?.meeting_notes ?? '') === 'true'
        const kind: SourceKind = isMeeting ? 'meeting' : 'artifact'
        if (!allow.has(kind)) continue
        const join = rows.find((r) => r.artifact_id === a.id)
        const at = enteredAt(join?.created_at ?? null, a.updated_at as string)
        if (!isNewer(at, since)) continue
        out.push({
          kind,
          id: a.id as string,
          label: `${a.title} (${isMeeting ? 'meeting notes' : String(a.type)})`,
          capturedAt: at,
          text: String(a.content ?? ''),
        })
      }
    }
  }

  // --- files (PDFs via their indexed text, text files inline) ---
  if (allow.has('file')) {
    const rows = await joinRows('collection_files', 'file_id')
    const ids = rows.map((r) => r.file_id)
    if (ids.length) {
      const { data: files } = await db
        .from('files')
        .select('id, name, description, mime_type, bucket, path, owner_id, visibility, created_at')
        .in('id', ids)
      for (const f of (files ?? []) as Array<Record<string, unknown>>) {
        if (f.owner_id !== userId && f.visibility === 'private') continue
        const join = rows.find((r) => r.file_id === f.id)
        const at = enteredAt(join?.created_at ?? null, f.created_at as string)
        if (!isNewer(at, since)) continue
        const text = await fileToText(
          db,
          f as { id: string; name: string; mime_type: string | null; bucket: string | null; path: string },
          userId,
        )
        if (!text) continue // image / binary — nothing to compile
        out.push({ kind: 'file', id: f.id as string, label: String(f.name), capturedAt: at, text })
      }
    }
  }

  // --- links (the fetched metadata + the user's own notes) ---
  if (allow.has('link')) {
    const rows = await joinRows('collection_links', 'link_id')
    const ids = rows.map((r) => r.link_id)
    if (ids.length) {
      const { data: links } = await db
        .from('links')
        .select('id, url, title, description, notes, owner_id, visibility, created_at, updated_at')
        .in('id', ids)
      for (const l of (links ?? []) as Array<Record<string, unknown>>) {
        if (l.owner_id !== userId && l.visibility === 'private') continue
        const join = rows.find((r) => r.link_id === l.id)
        const at = enteredAt(join?.created_at ?? null, l.updated_at as string)
        if (!isNewer(at, since)) continue
        out.push({
          kind: 'link',
          id: l.id as string,
          label: `${l.title || l.url}`,
          capturedAt: at,
          text: [`URL: ${l.url}`, l.description, l.notes].filter(Boolean).join('\n\n'),
        })
      }
    }
  }

  // --- inbox messages (email / Slack / anything pushed into the unified inbox) ---
  if (allow.has('message')) {
    const rows = await joinRows('collection_inbox_messages', 'message_id')
    const ids = rows.map((r) => r.message_id)
    if (ids.length) {
      const { data: msgs } = await db
        .from('inbox_messages')
        .select('id, subject, body, from_name, from_address, source, owner_id, visibility, created_at')
        .in('id', ids)
      for (const m of (msgs ?? []) as Array<Record<string, unknown>>) {
        if (m.owner_id && m.owner_id !== userId && m.visibility === 'private') continue
        const join = rows.find((r) => r.message_id === m.id)
        const at = enteredAt(join?.created_at ?? null, m.created_at as string)
        if (!isNewer(at, since)) continue
        out.push({
          kind: 'message',
          id: m.id as string,
          label: `${m.source ?? 'message'}: ${m.subject || '(no subject)'} — from ${m.from_name || m.from_address || 'unknown'}`,
          capturedAt: at,
          text: String(m.body ?? ''),
        })
      }
    }
  }

  // --- to-dos (a task is evidence of intent, and of what has been decided) ---
  if (allow.has('todo')) {
    const rows = await joinRows('collection_todos', 'todo_id')
    const ids = rows.map((r) => r.todo_id)
    if (ids.length) {
      const { data: todos } = await db
        .from('todos')
        .select('id, title, notes, due_date, done, owner_id, visibility, updated_at')
        .in('id', ids)
      for (const t of (todos ?? []) as Array<Record<string, unknown>>) {
        if (t.owner_id !== userId && t.visibility === 'private') continue
        const join = rows.find((r) => r.todo_id === t.id)
        const at = enteredAt(join?.created_at ?? null, t.updated_at as string)
        if (!isNewer(at, since)) continue
        out.push({
          kind: 'todo',
          id: t.id as string,
          label: `to-do: ${t.title}`,
          capturedAt: at,
          text: [t.notes, t.due_date ? `Due ${t.due_date}` : '', t.done ? 'Status: done' : 'Status: open']
            .filter(Boolean)
            .join('\n'),
        })
      }
    }
  }

  out.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))
  const truncated = Math.max(0, out.length - MAX_SOURCES)
  return { sources: out.slice(0, MAX_SOURCES), truncated }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

interface RunOpts {
  collection: Collection
  userId: string
  since: string | null
  dryRun: boolean
  trigger: string
}

async function runCompilation(db: DB, opts: RunOpts): Promise<{ runId: string; brief: string; counts: Record<string, number> }> {
  const { collection, userId, dryRun } = opts
  const startedAt = new Date().toISOString()
  const progress = initialProgress()

  const setStep = async (key: string, state: StepState, note = '') => {
    const step = progress.find((s) => s.key === key)
    if (step) {
      step.state = state
      step.note = note
    }
    if (runId) await db.from('compile_runs').update({ progress }).eq('id', runId)
  }

  const { data: runRow } = await db
    .from('compile_runs')
    .insert({
      owner_id: userId,
      collection_id: collection.id,
      status: 'running',
      trigger: opts.trigger,
      progress,
      started_at: startedAt,
    })
    .select('id')
    .single()
  const runId = runRow?.id as string

  const fail = async (message: string) => {
    await db
      .from('compile_runs')
      .update({ status: 'error', error: message, progress, finished_at: new Date().toISOString() })
      .eq('id', runId)
    return { runId, brief: '', counts: {} }
  }

  try {
    // --- 1. policy ---------------------------------------------------------
    await setStep('policy', 'running')
    const { data: policyRow } = await db
      .from('compile_policies')
      .select('policy, last_compiled_at')
      .eq('collection_id', collection.id)
      .maybeSingle()
    const policy = policyRow ? normalizePolicy(policyRow.policy) : { ...DEFAULT_POLICY }
    if (!policy.enabled) {
      await setStep('policy', 'done', 'compilation is off for this collection')
      return await fail('Compilation is turned off for this collection.')
    }
    const since = opts.since ?? (policyRow?.last_compiled_at as string | null) ?? null
    await setStep('policy', 'done', `autonomy: ${policy.autonomy}`)

    // --- 2. gather ---------------------------------------------------------
    await setStep('gather', 'running')
    const { sources, truncated } = await gatherSources(db, collection, userId, policy, since)
    await setStep(
      'gather',
      'done',
      `${sources.length} new source(s)${truncated ? `, ${truncated} deferred to the next pass` : ''}`,
    )

    // Load the compiled layer regardless — even with no new sources we still
    // want the staleness sweep to run.
    const { data: pageRows } = await db
      .from('knowledge_pages')
      .select('id, key, kind, title, content, status, confidence, human_confirmed, labels, last_reviewed_at, updated_at, artifact_id')
      .eq('collection_id', collection.id)
      .neq('status', 'archived')
    const pages: CompiledPage[] = ((pageRows ?? []) as Array<Record<string, unknown>>).map((p) => ({
      id: p.id as string,
      key: p.key as string,
      kind: p.kind as CompiledPage['kind'],
      title: p.title as string,
      content: (p.content as string) ?? '',
      status: p.status as CompiledPage['status'],
      confidence: Number(p.confidence ?? 0.5),
      humanConfirmed: Boolean(p.human_confirmed),
      labels: (p.labels as string[]) ?? [],
      lastReviewedAt: (p.last_reviewed_at as string) ?? null,
      updatedAt: (p.updated_at as string) ?? '',
    }))
    const artifactOf = new Map<string, string>()
    for (const p of (pageRows ?? []) as Array<Record<string, unknown>>) {
      if (p.artifact_id) artifactOf.set(p.id as string, p.artifact_id as string)
    }

    const created: Array<{ title: string; kind: string }> = []
    const updated: Array<{ title: string; op: string }> = []
    const review: Array<{ title: string; reason: string }> = []
    let output = { claims: [], updates: [], conflicts: [], relations: [], stale: [] as string[], notes: '' } as
      ReturnType<typeof parseCompilerOutput>['output']
    let cost = 0
    let claimsWritten = 0
    let linksWritten = 0

    // --- 3. extract --------------------------------------------------------
    if (!sources.length) {
      await setStep('extract', 'skipped', 'nothing new to read')
    } else {
      await setStep('extract', 'running', `reading ${sources.length} source(s)`)
      const { data: terms } = await db
        .from('collection_terminology')
        .select('term_id')
        .eq('collection_id', collection.id)
      const termIds = (terms ?? []).map((t: { term_id: string }) => t.term_id)
      let glossary: Array<{ term: string; definition: string }> = []
      if (termIds.length) {
        const { data: termRows } = await db.from('terminology').select('term, definition').in('id', termIds)
        glossary = (termRows ?? []) as Array<{ term: string; definition: string }>
      }

      const model = await resolveModel(db, 'orchestrator')
      const tz = await resolveWorkspaceTimezone(db)
      const prompt = buildCompilerPrompt({
        collectionName: collection.name,
        policy,
        pages,
        terms: glossary,
        sources,
        sourceBudget: SOURCE_BUDGET_CHARS,
      })
      const result = await orComplete({
        model,
        messages: [systemMsg(`${currentTimeSection(tz, new Date())}\n\n${prompt}`), { role: 'user', content: 'Compile these sources now. Reply with the JSON object only.' }],
        reasoning: reasoningParam(),
        maxTokens: 8000,
      })
      cost = result.usage?.cost ?? 0
      await recordUsage(db, { context: 'compile', model, usage: result.usage, actorId: userId })

      const parsed = parseCompilerOutput(result.content ?? '')
      if (!parsed.ok) {
        // Fail closed: an unreadable verdict compiles nothing at all.
        await setStep('extract', 'done', `unreadable reply (${parsed.error}) — nothing compiled`)
        return await fail(`The compiler model's reply could not be read (${parsed.error}). Nothing was written.`)
      }
      output = parsed.output
      await setStep(
        'extract',
        'done',
        `${output.claims.length} claim(s), ${output.updates.length} proposed update(s), ${output.conflicts.length} conflict(s)`,
      )
    }

    // --- 4. apply ----------------------------------------------------------
    await setStep('apply', dryRun ? 'skipped' : 'running', dryRun ? 'dry run — nothing written' : '')
    const now = new Date()
    const held: Array<{ update: typeof output.updates[number]; page: CompiledPage | null; reason: string }> = []

    for (const update of output.updates) {
      const page = matchPage(update, pages)
      const verdict = classifyUpdate(update, page, policy)

      if (verdict.decision === 'blocked') {
        review.push({ title: update.title, reason: verdict.reason })
        continue
      }
      if (verdict.decision === 'review') {
        review.push({ title: update.title, reason: verdict.reason })
        held.push({ update, page, reason: verdict.reason })
        continue
      }
      if (dryRun) {
        if (page) updated.push({ title: update.title, op: update.op })
        else created.push({ title: update.title, kind: update.kind })
        continue
      }

      const content = applyUpdateToContent(page, update, now)
      if (page) {
        await db
          .from('knowledge_pages')
          .update({ content, status: 'compiled', confidence: update.confidence, updated_at: now.toISOString() })
          .eq('id', page.id)
        page.content = content
        const artifactId = artifactOf.get(page.id)
        // Keep a linked artifact mirror in step, so a page published at a
        // durable URL stays current without a second edit.
        if (artifactId) await db.from('artifacts').update({ content }).eq('id', artifactId)
        updated.push({ title: update.title, op: update.op })
      } else {
        const { data: fresh } = await db
          .from('knowledge_pages')
          .insert({
            owner_id: userId,
            collection_id: collection.id,
            key: update.pageKey || pageKey(update.title),
            kind: update.kind,
            title: update.title,
            content,
            confidence: update.confidence,
            status: 'compiled',
            visibility: collection.visibility === 'workspace' ? 'workspace' : 'private',
          })
          .select('id, key, kind, title, content, status, confidence, human_confirmed, labels, last_reviewed_at, updated_at')
          .maybeSingle()
        if (fresh) {
          pages.push({
            id: fresh.id,
            key: fresh.key,
            kind: fresh.kind,
            title: fresh.title,
            content: fresh.content ?? '',
            status: fresh.status,
            confidence: Number(fresh.confidence ?? 0.5),
            humanConfirmed: Boolean(fresh.human_confirmed),
            labels: fresh.labels ?? [],
            lastReviewedAt: fresh.last_reviewed_at ?? null,
            updatedAt: fresh.updated_at ?? now.toISOString(),
          })
          created.push({ title: update.title, kind: update.kind })
        }
      }
    }

    // Claims — the provenance layer. Deduped by fingerprint so re-running a pass
    // over overlapping sources doesn't restate the same claim forever.
    if (!dryRun && output.claims.length) {
      const { data: existing } = await db
        .from('knowledge_claims')
        .select('fingerprint')
        .eq('owner_id', userId)
        .eq('collection_id', collection.id)
      const fresh = dedupeClaims(
        output.claims,
        (existing ?? []).map((c: { fingerprint: string }) => c.fingerprint),
      )
      const byId = new Map(sources.map((s) => [s.id, s]))
      const rows = fresh.map((c) => {
        const src = c.sourceId ? byId.get(c.sourceId) : undefined
        const page = c.pageKey ? pages.find((p) => p.key === c.pageKey) : undefined
        return {
          owner_id: userId,
          collection_id: collection.id,
          page_id: page?.id ?? null,
          statement: c.statement,
          fingerprint: claimFingerprint(c.statement),
          source_type: src?.kind ?? 'manual',
          source_id: src ? src.id : null,
          source_label: src?.label ?? '',
          captured_at: src?.capturedAt ?? now.toISOString(),
          confidence: c.confidence,
          run_id: runId,
        }
      })
      if (rows.length) {
        const { error } = await db
          .from('knowledge_claims')
          .upsert(rows, { onConflict: 'owner_id,collection_id,fingerprint', ignoreDuplicates: true })
        if (!error) claimsWritten = rows.length
      }
    }

    // Relations — resolve page keys to ids where we can, so the graph is real.
    if (!dryRun && output.relations.length) {
      const keyToId = new Map(pages.map((p) => [p.key, p.id]))
      const rows = output.relations.map((r) => ({
        owner_id: userId,
        collection_id: collection.id,
        from_type: r.fromType,
        from_id: keyToId.get(pageKey(r.fromId)) ?? r.fromId,
        to_type: r.toType,
        to_id: keyToId.get(pageKey(r.toId)) ?? r.toId,
        rel: r.rel,
        run_id: runId,
      }))
      const { error } = await db
        .from('knowledge_links')
        .upsert(rows, { onConflict: 'owner_id,from_type,from_id,to_type,to_id,rel', ignoreDuplicates: true })
      if (!error) linksWritten = rows.length
    }
    if (!dryRun) await setStep('apply', 'done', `${created.length} created, ${updated.length} updated`)

    // --- 5. flag -----------------------------------------------------------
    await setStep('flag', 'running')
    const staleKeys = stalePageKeys(pages, now, policy.staleDays)
    if (!dryRun) {
      if (staleKeys.length) {
        await db
          .from('knowledge_pages')
          .update({ status: 'stale' })
          .eq('collection_id', collection.id)
          .in('key', staleKeys)
      }

      // A true contradiction marks the page as disputed. It is NOT rewritten —
      // the whole point is that a human decides which source is current.
      for (const c of output.conflicts) {
        const page = c.pageKey ? pages.find((p) => p.key === c.pageKey) : undefined
        await db.from('knowledge_conflicts').insert({
          owner_id: userId,
          collection_id: collection.id,
          page_id: page?.id ?? null,
          title: page?.title ?? (c.incoming.slice(0, 80) || 'Conflict'),
          existing_text: c.existing,
          incoming_text: c.incoming,
          impact: c.impact,
          suggested_action: c.suggestedAction,
          severity: c.severity,
          category: 'conflict',
          source_ids: c.sourceIds,
          run_id: runId,
        })
        if (page) {
          await db.from('knowledge_pages').update({ status: 'contradicted' }).eq('id', page.id)
        }
      }

      // Updates the trust boundary declined are parked WITH their proposed body,
      // so approving one later is a click rather than a re-run.
      for (const h of held) {
        await db.from('knowledge_conflicts').insert({
          owner_id: userId,
          collection_id: collection.id,
          page_id: h.page?.id ?? null,
          title: h.update.title,
          existing_text: h.page ? (h.page.content ?? '').slice(0, 2000) : '',
          incoming_text: h.update.body.slice(0, 2000),
          impact: h.update.reason,
          suggested_action: `Approve to ${h.update.op} this page, or keep the current version.`,
          severity: 'low',
          category: 'held',
          proposed: {
            op: h.update.op,
            page_key: h.update.pageKey,
            kind: h.update.kind,
            title: h.update.title,
            body: h.update.body,
          },
          source_ids: h.update.sourceIds,
          run_id: runId,
        })
        // Mark the page the held update targets, so the pending change is
        // VISIBLE wherever the page is read. Without this the page keeps
        // reading as settled truth while a revision waits in the queue, and an
        // agent quoting it asserts something no human has accepted yet — which
        // is exactly how a review gate turns into a silent staleness bug.
        // A page a human already confirmed keeps that status: a queued
        // suggestion does not undo their sign-off. Contradicted outranks this
        // (a real dispute is worse than a pending edit) and is set above.
        if (h.page && shouldFlagPendingReview(h.page)) {
          await db.from('knowledge_pages').update({ status: 'needs-review' }).eq('id', h.page.id)
          h.page.status = 'needs-review'
        }
      }
    }
    await setStep('flag', 'done', `${output.conflicts.length} conflict(s), ${held.length} held, ${staleKeys.length} stale`)

    // --- 6. brief ----------------------------------------------------------
    await setStep('brief', 'running')
    const briefInput = {
      collectionName: collection.name,
      startedAt,
      sourcesSeen: sources.length,
      created,
      updated,
      review,
      conflicts: output.conflicts,
      stale: staleKeys,
      linked: linksWritten,
      claims: claimsWritten,
      notes: [output.notes, truncated ? `${truncated} further source(s) will be compiled on the next pass.` : '']
        .filter(Boolean)
        .join(' '),
    }
    const brief = formatChangeBrief(briefInput)
    const counts = briefCounts(briefInput)
    await setStep('brief', 'done')

    await db
      .from('compile_runs')
      .update({
        status: 'ok',
        sources_seen: sources.length,
        counts,
        brief,
        progress,
        cost,
        detail: { dry_run: dryRun, since, truncated, autonomy: policy.autonomy },
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)

    if (!dryRun) {
      // Advance the cursor only on a real pass, so a dry run never causes the
      // next real one to skip the sources it merely previewed.
      await db
        .from('compile_policies')
        .upsert(
          {
            collection_id: collection.id,
            owner_id: userId,
            policy: policyRow?.policy ?? {},
            last_compiled_at: new Date().toISOString(),
          },
          { onConflict: 'collection_id' },
        )
      await db.from('activity_log').insert({
        type: 'knowledge.compiled',
        summary: `Compiled "${collection.name}": ${counts.created} created, ${counts.updated} updated, ${counts.conflicts} conflict(s)`,
        detail: { run_id: runId, collection_id: collection.id, counts },
        actor_id: userId,
      })
    }

    return { runId, brief, counts: counts as unknown as Record<string, number> }
  } catch (err) {
    return await fail(err instanceof Error ? err.message : 'compilation failed')
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const db = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )

  if (req.method === 'GET') {
    return json({
      ok: true,
      service: 'compile',
      usage: 'POST { collection, since?, dry_run?, background? } with a session JWT or an mcp_tokens bearer.',
    })
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  // Auth. A session JWT or a personal mcp_tokens bearer resolves to that user.
  // An INTERNAL caller (the compile_collection builtin, running inside another
  // edge function) presents the service-role key instead and names the user the
  // pass runs as — `triggered_by` is honored ONLY on that path, mirroring how
  // loops/evals attribute an internally-triggered run, so a normal caller can
  // never claim to be somebody else.
  const token = parseBearer(req.headers.get('Authorization'))
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const internal = Boolean(token) && Boolean(serviceKey) && token === serviceKey
  const userId = internal
    ? String(body.triggered_by ?? body.triggeredBy ?? '').trim() || null
    : token
      ? await resolveApiUser(db, token)
      : null
  if (!userId) return json({ error: 'Unauthorized' }, 401)

  const ref = String(body.collection ?? body.collectionId ?? body.collection_id ?? '').trim()
  if (!ref) return json({ error: 'A collection (name or id) is required.' }, 400)
  const collection = await resolveCollection(db, userId, ref)
  if (!collection) return json({ error: `No collection you can access matches "${ref}".` }, 404)

  const opts: RunOpts = {
    collection,
    userId,
    since: typeof body.since === 'string' && body.since.trim() ? body.since.trim() : null,
    dryRun: Boolean(body.dry_run ?? body.dryRun),
    trigger: ['manual', 'event', 'schedule', 'tool'].includes(String(body.trigger))
      ? String(body.trigger)
      : 'manual',
  }

  // A pass over a real collection outlives a browser request, so the UI kicks it
  // off in the background and follows `compile_runs` over Realtime instead.
  if (body.background) {
    // deno-lint-ignore no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime
    const task = runCompilation(db, opts)
    if (runtime?.waitUntil) runtime.waitUntil(task)
    return json({ ok: true, background: true, collection: collection.name })
  }

  const result = await runCompilation(db, opts)
  return json({ ok: true, ...result })
})
