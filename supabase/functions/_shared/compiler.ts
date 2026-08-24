// The knowledge compiler's pure core.
//
// The workspace's default flow has always been "add information -> search for it
// later -> generate an answer". The compiler flips the center of gravity to
// "add information -> interpret it -> link it -> update existing knowledge ->
// flag conflicts -> produce a brief". A raw file stops being an answer and
// becomes EVIDENCE; the answer lives in a maintained compiled page.
//
// Everything here is deliberately pure and import-side-effect-free (same
// discipline as evals_pure.ts / security.ts) so the judgment calls — above all
// the TRUST BOUNDARY that decides what a machine may rewrite unattended — are
// unit-testable rather than buried in an edge function. The `compile` function
// does the I/O; this module decides what the I/O is allowed to be.
//
// Vocabulary:
//   source   a raw item that entered the workspace (file, link, message, ...)
//   claim    one atomic statement extracted from a source, with provenance
//   page     a maintained compiled page (concept, decision, project, ...)
//   update   a proposed change to a page (create | append | revise | supersede)
//   conflict new evidence that contradicts compiled knowledge -> a review item
//   brief    the change report a compilation run produces

// ---------------------------------------------------------------------------
// Vocabulary constants
// ---------------------------------------------------------------------------

/** Raw source kinds the compiler can read out of a collection. */
export const SOURCE_KINDS = [
  'file',
  'link',
  'message',
  'artifact',
  'todo',
  'meeting',
  'note',
  'manual',
] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** The compiled layer. These are the pages a collection MAINTAINS. */
export const PAGE_KINDS = [
  'concept',
  'decision',
  'process',
  'person',
  'project',
  'terminology',
  'principle',
  'question',
  'profile',
] as const
export type PageKind = (typeof PAGE_KINDS)[number]

/** Lifecycle of a compiled page (the doc's "knowledge status"). */
export const PAGE_STATUSES = [
  'processing',
  'compiled',
  'needs-review',
  'contradicted',
  'stale',
  'confirmed',
  'archived',
] as const
export type PageStatus = (typeof PAGE_STATUSES)[number]

/**
 * How much the compiler may change without a human.
 *   suggest  nothing is written unattended; every update becomes a review item
 *   guarded  new pages and additive appends apply; rewrites go to review
 *   auto     rewrites apply too; wholesale replacement still goes to review
 * `guarded` is the default on purpose: compilation amplifies mistakes, so the
 * safe-by-default posture is "grow knowledge freely, rewrite it deliberately".
 */
export const AUTONOMY_LEVELS = ['suggest', 'guarded', 'auto'] as const
export type Autonomy = (typeof AUTONOMY_LEVELS)[number]

/**
 * The operations an update can propose, ordered by how destructive they are.
 * The trust boundary is expressed as a ceiling on this ladder.
 */
export const UPDATE_OPS = ['create', 'append', 'revise', 'supersede'] as const
export type UpdateOp = (typeof UPDATE_OPS)[number]

const OP_RISK: Record<UpdateOp, number> = { create: 0, append: 1, revise: 2, supersede: 3 }

/** The highest-risk op each autonomy level may apply unattended. */
const AUTONOMY_CEILING: Record<Autonomy, number> = {
  suggest: -1, // nothing
  guarded: OP_RISK.append,
  auto: OP_RISK.revise, // `supersede` is never unattended, at any level
}

export const DEFAULT_STALE_DAYS = 90
export const DEFAULT_MIN_CONFIDENCE = 0.5

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** A collection's compilation policy — what gets compiled together, and how freely. */
export interface CompilePolicy {
  enabled: boolean
  autonomy: Autonomy
  /** Raw source kinds this collection compiles from. */
  compileSources: SourceKind[]
  /** Compiled page kinds this collection maintains. An update to any other kind is out of policy. */
  maintainKinds: PageKind[]
  /**
   * Never touched unattended. Each entry matches a page by kind, by label, or by
   * a case-insensitive substring of its title — so "financial commitments",
   * "client-facing", and "decision" are all expressible without a schema change.
   */
  neverAuto: string[]
  /** Updates below this confidence go to review rather than applying. */
  minConfidence: number
  /** A compiled page not reviewed in this many days is flagged stale. */
  staleDays: number
}

export const DEFAULT_POLICY: CompilePolicy = {
  enabled: true,
  autonomy: 'guarded',
  compileSources: ['file', 'link', 'message', 'artifact', 'meeting', 'note'],
  maintainKinds: ['concept', 'decision', 'process', 'person', 'project', 'terminology', 'principle', 'question'],
  neverAuto: [],
  minConfidence: DEFAULT_MIN_CONFIDENCE,
  staleDays: DEFAULT_STALE_DAYS,
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = String(value ?? '').trim().toLowerCase()
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function pickEnumList<T extends string>(value: unknown, allowed: readonly T[], fallback: T[]): T[] {
  if (!Array.isArray(value)) return [...fallback]
  const out: T[] = []
  for (const raw of value) {
    const v = String(raw ?? '').trim().toLowerCase()
    if ((allowed as readonly string[]).includes(v) && !out.includes(v as T)) out.push(v as T)
  }
  return out.length ? out : [...fallback]
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Coerce a stored (or model-supplied) policy blob into a valid policy. Unknown
 * source/page kinds are dropped rather than trusted — the policy is an
 * allow-list, so a typo must never silently widen what compilation may touch.
 */
export function normalizePolicy(raw: unknown): CompilePolicy {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    enabled: r.enabled === undefined ? DEFAULT_POLICY.enabled : Boolean(r.enabled),
    autonomy: pickEnum(r.autonomy, AUTONOMY_LEVELS, DEFAULT_POLICY.autonomy),
    compileSources: pickEnumList(r.compile_sources ?? r.compileSources, SOURCE_KINDS, DEFAULT_POLICY.compileSources),
    maintainKinds: pickEnumList(r.maintain_kinds ?? r.maintainKinds, PAGE_KINDS, DEFAULT_POLICY.maintainKinds),
    neverAuto: Array.isArray(r.never_auto ?? r.neverAuto)
      ? ((r.never_auto ?? r.neverAuto) as unknown[])
          .map((v) => String(v ?? '').trim())
          .filter(Boolean)
      : [...DEFAULT_POLICY.neverAuto],
    minConfidence: clamp(Number(r.min_confidence ?? r.minConfidence ?? DEFAULT_MIN_CONFIDENCE), 0, 1),
    staleDays: Math.round(clamp(Number(r.stale_days ?? r.staleDays ?? DEFAULT_STALE_DAYS), 1, 3650)),
  }
}

/** Serialize a policy back to the snake_case jsonb shape stored on the row. */
export function policyToJson(policy: CompilePolicy): Record<string, unknown> {
  return {
    enabled: policy.enabled,
    autonomy: policy.autonomy,
    compile_sources: policy.compileSources,
    maintain_kinds: policy.maintainKinds,
    never_auto: policy.neverAuto,
    min_confidence: policy.minConfidence,
    stale_days: policy.staleDays,
  }
}

// ---------------------------------------------------------------------------
// Domain shapes
// ---------------------------------------------------------------------------

export interface RawSource {
  kind: SourceKind
  /** Row id of the underlying file/link/message/artifact. */
  id: string
  label: string
  /** ISO timestamp the source entered (or was last changed in) the workspace. */
  capturedAt: string
  text: string
}

export interface CompiledPage {
  id: string
  /** Stable upsert key — a slug of the title, so a refined page overwrites in place. */
  key: string
  kind: PageKind
  title: string
  content: string
  status: PageStatus
  confidence: number
  humanConfirmed: boolean
  labels: string[]
  lastReviewedAt: string | null
  updatedAt: string
}

export interface ExtractedClaim {
  statement: string
  pageKey: string | null
  kind: PageKind | null
  confidence: number
  sourceId: string | null
}

export interface PageUpdate {
  op: UpdateOp
  pageKey: string
  kind: PageKind
  title: string
  /** The text to append (op=append) or the replacement body (revise/supersede/create). */
  body: string
  reason: string
  confidence: number
  /** Page keys / claim statements this update contradicts. Non-empty forces review. */
  conflictsWith: string[]
  sourceIds: string[]
}

export interface DetectedConflict {
  pageKey: string | null
  existing: string
  incoming: string
  impact: string
  suggestedAction: string
  severity: 'low' | 'medium' | 'high'
  sourceIds: string[]
}

export interface KnowledgeRelation {
  fromType: string
  fromId: string
  toType: string
  toId: string
  rel: string
}

export interface CompilerOutput {
  claims: ExtractedClaim[]
  updates: PageUpdate[]
  conflicts: DetectedConflict[]
  relations: KnowledgeRelation[]
  /** Page keys the model believes are now out of date. */
  stale: string[]
  notes: string
}

export const EMPTY_OUTPUT: CompilerOutput = {
  claims: [],
  updates: [],
  conflicts: [],
  relations: [],
  stale: [],
  notes: '',
}

// ---------------------------------------------------------------------------
// Keys and fingerprints
// ---------------------------------------------------------------------------

/**
 * Stable upsert key for a compiled page. Refining "Payment Schedule" must land
 * on the same page as "payment schedule" — otherwise the compiler duplicates
 * knowledge instead of maintaining it, which is the whole failure mode this
 * feature exists to prevent.
 */
export function pageKey(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/**
 * Fingerprint of a claim's statement, used to avoid re-storing the same claim
 * every run. Case, punctuation and filler whitespace are normalized away so a
 * re-extraction of the same sentence collapses onto the existing row.
 */
export function claimFingerprint(statement: string): string {
  return String(statement ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** Drop claims already stored (by fingerprint) and de-duplicate within the batch. */
export function dedupeClaims(claims: ExtractedClaim[], existingFingerprints: Iterable<string>): ExtractedClaim[] {
  const seen = new Set<string>()
  for (const f of existingFingerprints) seen.add(f)
  const out: ExtractedClaim[] = []
  for (const c of claims) {
    const fp = claimFingerprint(c.statement)
    if (!fp || seen.has(fp)) continue
    seen.add(fp)
    out.push(c)
  }
  return out
}

// ---------------------------------------------------------------------------
// Parsing the model's output
// ---------------------------------------------------------------------------

/** Pull the outermost JSON object out of a model reply that may be fenced or chatty. */
function extractJsonObject(text: string): string | null {
  const raw = String(text ?? '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : raw).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return body.slice(start, end + 1)
}

function str(v: unknown, max = 4000): string {
  return String(v ?? '').trim().slice(0, max)
}

function strList(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => str(x, 300)).filter(Boolean).slice(0, max)
}

function conf(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? clamp(n, 0, 1) : 0.5
}

/**
 * Parse the compiler model's strict-JSON verdict. Fails CLOSED: anything that
 * doesn't parse yields an empty output with an error, so a garbled reply
 * results in "nothing was compiled" rather than a half-applied rewrite.
 */
export function parseCompilerOutput(text: string): { ok: boolean; output: CompilerOutput; error: string | null } {
  const json = extractJsonObject(text)
  if (!json) return { ok: false, output: { ...EMPTY_OUTPUT }, error: 'no JSON object in the reply' }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json) as Record<string, unknown>
  } catch (err) {
    return {
      ok: false,
      output: { ...EMPTY_OUTPUT },
      error: `invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
    }
  }

  const claims: ExtractedClaim[] = (Array.isArray(parsed.claims) ? parsed.claims : [])
    .map((raw) => {
      const c = (raw ?? {}) as Record<string, unknown>
      const statement = str(c.statement ?? c.text, 1000)
      if (!statement) return null
      const kind = String(c.kind ?? '').trim().toLowerCase()
      const key = str(c.page_key ?? c.pageKey, 100)
      return {
        statement,
        pageKey: key ? pageKey(key) : null,
        kind: (PAGE_KINDS as readonly string[]).includes(kind) ? (kind as PageKind) : null,
        confidence: conf(c.confidence),
        sourceId: str(c.source_id ?? c.sourceId, 100) || null,
      }
    })
    .filter(Boolean) as ExtractedClaim[]

  const updates: PageUpdate[] = (Array.isArray(parsed.updates ?? parsed.page_updates) ? (parsed.updates ?? parsed.page_updates) as unknown[] : [])
    .map((raw) => {
      const u = (raw ?? {}) as Record<string, unknown>
      const title = str(u.title, 200)
      const key = str(u.page_key ?? u.pageKey, 100)
      if (!title && !key) return null
      const kind = String(u.kind ?? '').trim().toLowerCase()
      const op = String(u.op ?? u.operation ?? '').trim().toLowerCase()
      const body = str(u.body ?? u.content, 20000)
      if (!body) return null
      return {
        op: (UPDATE_OPS as readonly string[]).includes(op) ? (op as UpdateOp) : 'append',
        pageKey: key ? pageKey(key) : pageKey(title),
        kind: (PAGE_KINDS as readonly string[]).includes(kind) ? (kind as PageKind) : 'concept',
        title: title || key,
        body,
        reason: str(u.reason, 500),
        confidence: conf(u.confidence),
        conflictsWith: strList(u.conflicts_with ?? u.conflictsWith),
        sourceIds: strList(u.source_ids ?? u.sourceIds),
      }
    })
    .filter(Boolean) as PageUpdate[]

  const conflicts: DetectedConflict[] = (Array.isArray(parsed.conflicts) ? parsed.conflicts : [])
    .map((raw) => {
      const c = (raw ?? {}) as Record<string, unknown>
      const incoming = str(c.incoming ?? c.new ?? c.new_source, 2000)
      const existing = str(c.existing ?? c.existing_knowledge, 2000)
      if (!incoming && !existing) return null
      const sev = String(c.severity ?? '').trim().toLowerCase()
      const key = str(c.page_key ?? c.pageKey, 100)
      return {
        pageKey: key ? pageKey(key) : null,
        existing,
        incoming,
        impact: str(c.impact, 1000),
        suggestedAction: str(c.suggested_action ?? c.suggestedAction, 1000),
        severity: (['low', 'medium', 'high'].includes(sev) ? sev : 'medium') as 'low' | 'medium' | 'high',
        sourceIds: strList(c.source_ids ?? c.sourceIds),
      }
    })
    .filter(Boolean) as DetectedConflict[]

  const relations: KnowledgeRelation[] = (Array.isArray(parsed.relations ?? parsed.links) ? (parsed.relations ?? parsed.links) as unknown[] : [])
    .map((raw) => {
      const l = (raw ?? {}) as Record<string, unknown>
      const fromId = str(l.from_id ?? l.fromId, 200)
      const toId = str(l.to_id ?? l.toId, 200)
      if (!fromId || !toId) return null
      return {
        fromType: str(l.from_type ?? l.fromType, 50) || 'page',
        fromId,
        toType: str(l.to_type ?? l.toType, 50) || 'page',
        toId,
        rel: str(l.rel ?? l.relation, 50) || 'relates-to',
      }
    })
    .filter(Boolean) as KnowledgeRelation[]

  return {
    ok: true,
    output: {
      claims,
      updates,
      conflicts,
      relations,
      stale: strList(parsed.stale).map((s) => pageKey(s)).filter(Boolean),
      notes: str(parsed.notes, 2000),
    },
    error: null,
  }
}

// ---------------------------------------------------------------------------
// Matching an update to an existing page
// ---------------------------------------------------------------------------

/**
 * Find the compiled page an update targets: exact key first, then a normalized
 * title match, then a same-kind title-containment match. Returns null for a
 * genuinely new page.
 */
export function matchPage(update: PageUpdate, pages: CompiledPage[]): CompiledPage | null {
  const key = update.pageKey
  const byKey = pages.find((p) => p.key === key)
  if (byKey) return byKey
  const titleKey = pageKey(update.title)
  const byTitle = pages.find((p) => p.key === titleKey || pageKey(p.title) === titleKey)
  if (byTitle) return byTitle
  if (!titleKey) return null
  const sameKind = pages.filter((p) => p.kind === update.kind)
  return (
    sameKind.find((p) => {
      const pk = pageKey(p.title)
      return pk.length > 3 && titleKey.length > 3 && (pk.includes(titleKey) || titleKey.includes(pk))
    }) ?? null
  )
}

// ---------------------------------------------------------------------------
// The trust boundary
// ---------------------------------------------------------------------------

export type UpdateDecision = 'apply' | 'review' | 'blocked'

export interface UpdateVerdict {
  decision: UpdateDecision
  reason: string
}

/**
 * Does a page fall under one of the policy's never-auto guards? A guard matches
 * the page's kind, any of its labels, or a substring of its title — so
 * "financial commitments", "client-facing" and "decision" all work as written
 * by a human in the policy editor.
 */
export function isProtected(page: CompiledPage | null, policy: CompilePolicy): boolean {
  if (!page || !policy.neverAuto.length) return false
  const haystack = [page.kind, page.title, ...(page.labels ?? [])].map((s) => String(s ?? '').toLowerCase())
  return policy.neverAuto.some((guardRaw) => {
    const guard = guardRaw.toLowerCase().trim()
    if (!guard) return false
    return haystack.some((h) => h === guard || h.includes(guard))
  })
}

/**
 * THE trust boundary. Decide whether an update may be written unattended,
 * must become a human review item, or is out of policy entirely.
 *
 * Ordering matters: out-of-policy is checked before anything else (a disabled
 * policy or an unmaintained kind means the compiler has no business here at
 * all), then the hard guards that hold at EVERY autonomy level — protected
 * pages, contradictions, human-confirmed pages, low confidence, wholesale
 * replacement — and only then the autonomy ceiling. A page a human confirmed
 * can still be appended to; it just can't be rewritten behind their back.
 */
export function classifyUpdate(
  update: PageUpdate,
  page: CompiledPage | null,
  policy: CompilePolicy,
): UpdateVerdict {
  if (!policy.enabled) return { decision: 'blocked', reason: 'compilation is off for this collection' }
  if (!policy.maintainKinds.includes(update.kind)) {
    return { decision: 'blocked', reason: `this collection does not maintain "${update.kind}" pages` }
  }
  if (update.op !== 'create' && !page) {
    // The model wants to change a page that isn't there; treat it as a create.
    update = { ...update, op: 'create' }
  }
  if (update.op === 'create' && page) {
    // The page already exists, so a "create" is really an append to it.
    update = { ...update, op: 'append' }
  }

  if (isProtected(page, policy)) {
    return { decision: 'review', reason: 'the page is protected by this collection’s never-auto policy' }
  }
  if (update.conflictsWith.length) {
    return { decision: 'review', reason: 'the update contradicts existing compiled knowledge' }
  }
  if (page?.humanConfirmed && update.op !== 'append') {
    return { decision: 'review', reason: 'the page is human-confirmed, so it is only appended to automatically' }
  }
  if (update.confidence < policy.minConfidence) {
    return {
      decision: 'review',
      reason: `confidence ${update.confidence.toFixed(2)} is below the ${policy.minConfidence.toFixed(2)} threshold`,
    }
  }
  if (update.op === 'supersede') {
    return { decision: 'review', reason: 'replacing a page wholesale always needs a human' }
  }
  if (OP_RISK[update.op] > AUTONOMY_CEILING[policy.autonomy]) {
    return { decision: 'review', reason: `autonomy is "${policy.autonomy}", which does not apply a ${update.op}` }
  }
  return { decision: 'apply', reason: `${update.op} within policy` }
}

/**
 * Apply an update's body to a page's content. `append` grows the page under a
 * dated heading (so provenance is visible in the page itself); the rewriting
 * ops replace it. Returns the new content.
 */
export function applyUpdateToContent(page: CompiledPage | null, update: PageUpdate, now: Date): string {
  const stamp = now.toISOString().slice(0, 10)
  if (!page || update.op === 'create') return update.body.trim()
  if (update.op === 'append') {
    const existing = (page.content ?? '').trimEnd()
    const addition = `\n\n<!-- compiled ${stamp} -->\n${update.body.trim()}`
    return `${existing}${addition}`.trim()
  }
  return update.body.trim()
}

/**
 * When the trust boundary parks an update for review, should the page it targets
 * be flagged `needs-review`?
 *
 * The point is visibility. A held update means "a change to this page was
 * proposed and nobody has accepted it yet" — and unless the page says so, it
 * keeps reading as settled truth while the revision waits in the queue. That is
 * how a review gate quietly becomes a staleness bug.
 *
 * Two pages are left alone. A `contradicted` page is already flagged with
 * something WORSE (a real dispute beats a pending edit, so don't downgrade it),
 * and a human-confirmed page keeps its sign-off — a machine's suggestion does
 * not retroactively un-confirm what a person accepted.
 */
export function shouldFlagPendingReview(page: CompiledPage | null): boolean {
  if (!page) return false
  if (page.status === 'contradicted') return false
  if (page.humanConfirmed) return false
  return page.status !== 'needs-review'
}

/**
 * Which archived pages should a listing include?
 *
 * Archiving a compiled page is this feature's soft delete, and it has to behave
 * like every other soft delete in the workspace (artifacts and skills, since
 * 0101): hidden from normal listings, reachable only when you deliberately ask
 * for the recovery area. Getting this wrong is worse here than elsewhere — the
 * whole premise is that a compiled page carries MORE authority than a raw file,
 * so a page someone archived because it was wrong must not keep surfacing to
 * agents as maintained knowledge.
 */
export type ArchiveScope = 'live' | 'archived'

export function archiveScope(input: { archived?: unknown }): ArchiveScope {
  return input?.archived === true ? 'archived' : 'live'
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export type Freshness = 'fresh' | 'aging' | 'stale'

/**
 * How stale is a compiled page? Measured from the last HUMAN review when there
 * is one, otherwise from its last write — a page the compiler keeps touching on
 * its own is not thereby verified.
 */
export function freshnessOf(page: CompiledPage, now: Date, staleDays = DEFAULT_STALE_DAYS): Freshness {
  const basis = page.lastReviewedAt ?? page.updatedAt
  const t = Date.parse(basis ?? '')
  if (!Number.isFinite(t)) return 'stale'
  const days = (now.getTime() - t) / 86_400_000
  if (days >= staleDays) return 'stale'
  if (days >= staleDays / 2) return 'aging'
  return 'fresh'
}

/** Page keys that should be flagged stale on this run (never re-flagging one already stale/archived). */
export function stalePageKeys(pages: CompiledPage[], now: Date, staleDays = DEFAULT_STALE_DAYS): string[] {
  return pages
    .filter((p) => p.status !== 'stale' && p.status !== 'archived')
    .filter((p) => freshnessOf(p, now, staleDays) === 'stale')
    .map((p) => p.key)
}

// ---------------------------------------------------------------------------
// The compiler prompt
// ---------------------------------------------------------------------------

export interface PromptInput {
  collectionName: string
  policy: CompilePolicy
  pages: CompiledPage[]
  terms: Array<{ term: string; definition: string }>
  sources: RawSource[]
  /** Character budget for the raw source text (the model's context is finite). */
  sourceBudget?: number
}

const OUTPUT_CONTRACT = `Reply with ONE JSON object and nothing else:
{
  "claims":    [{"statement": "...", "page_key": "payment-schedule", "kind": "decision", "confidence": 0.0-1.0, "source_id": "..."}],
  "updates":   [{"op": "create|append|revise|supersede", "page_key": "...", "kind": "...", "title": "...", "body": "markdown", "reason": "...", "confidence": 0.0-1.0, "conflicts_with": ["page-key or claim"], "source_ids": ["..."]}],
  "conflicts": [{"page_key": "...", "existing": "what compiled knowledge says", "incoming": "what the new source says", "impact": "what may now be wrong", "suggested_action": "what a human should decide", "severity": "low|medium|high", "source_ids": ["..."]}],
  "relations": [{"from_type": "page|source", "from_id": "...", "to_type": "page|source", "to_id": "...", "rel": "supports|contradicts|mentions|depends-on|relates-to"}],
  "stale":     ["page-key"],
  "notes":     "one or two sentences about the pass"
}`

/** Trim a source's text to fit a per-source share of the budget. */
function budgetedSources(sources: RawSource[], budget: number): string {
  if (!sources.length) return '(no new sources)'
  const per = Math.max(400, Math.floor(budget / sources.length))
  return sources
    .map((s) => {
      const body = s.text.length > per ? `${s.text.slice(0, per)}\n…[truncated]` : s.text
      return `### SOURCE ${s.id}\nkind: ${s.kind}\nlabel: ${s.label}\ncaptured: ${s.capturedAt}\n\n${body}`
    })
    .join('\n\n')
}

/**
 * Build the extraction prompt. Pure so the contract we hold the model to is
 * itself testable — the interesting invariants (never invent, cite source ids,
 * prefer updating an existing page over minting a near-duplicate, raise a
 * conflict rather than picking a winner) are asserted in the unit tests.
 */
export function buildCompilerPrompt(input: PromptInput): string {
  const { collectionName, policy, pages, terms, sources } = input
  const budget = input.sourceBudget ?? 60_000

  const pageIndex = pages.length
    ? pages
        .map(
          (p) =>
            `- ${p.key} [${p.kind}] "${p.title}" (status: ${p.status}${p.humanConfirmed ? ', human-confirmed' : ''})\n${
              p.content.slice(0, 1200)
            }`,
        )
        .join('\n\n')
    : '(nothing compiled yet — this is the first pass)'

  const glossary = terms.length
    ? terms.map((t) => `- ${t.term}: ${t.definition.slice(0, 200)}`).join('\n')
    : '(no terms yet)'

  return `You are the knowledge compiler for the "${collectionName}" collection.

Your job is NOT to answer a question. It is to convert new raw sources into
MAINTAINED knowledge: extract what they claim, fold it into the compiled pages
that already exist, link it up, and flag anything that contradicts what is
already known.

RULES
1. Never invent. Every claim and every update must be traceable to a source id below.
2. Prefer UPDATING an existing page over creating a near-duplicate. Match by meaning, not wording.
3. Use "append" when you are adding new knowledge, "revise" when you are correcting
   existing wording, "supersede" only when a page is wholly out of date.
4. When a new source disagrees with compiled knowledge, DO NOT pick a winner.
   Emit a conflict and leave the page alone. A human decides which source is current.
5. Only these page kinds are maintained here: ${policy.maintainKinds.join(', ')}.
6. Keep page bodies in markdown, written as durable reference prose — not as a
   summary of "what this document said". A compiled page should read like the
   current truth, with its evidence cited inline as (source: <label>).
7. Reuse existing terminology. Only introduce a term that is genuinely new.
8. Be conservative with confidence. Below ${policy.minConfidence.toFixed(2)} means a human reviews it.

COMPILED PAGES (the current state of knowledge)
${pageIndex}

GLOSSARY
${glossary}

NEW RAW SOURCES (evidence — not answers)
${budgetedSources(sources, budget)}

${OUTPUT_CONTRACT}`
}

// ---------------------------------------------------------------------------
// The change brief
// ---------------------------------------------------------------------------

export interface BriefInput {
  collectionName: string
  startedAt: string
  sourcesSeen: number
  created: Array<{ title: string; kind: string }>
  updated: Array<{ title: string; op: string }>
  review: Array<{ title: string; reason: string }>
  conflicts: DetectedConflict[]
  stale: string[]
  linked: number
  claims: number
  notes?: string
}

export interface BriefCounts {
  created: number
  updated: number
  review: number
  conflicts: number
  stale: number
  linked: number
  claims: number
  sources: number
}

/** Headline numbers for a run — shared by the brief, the UI, and the tool reply. */
export function briefCounts(input: BriefInput): BriefCounts {
  return {
    created: input.created.length,
    updated: input.updated.length,
    review: input.review.length,
    conflicts: input.conflicts.length,
    stale: input.stale.length,
    linked: input.linked,
    claims: input.claims,
    sources: input.sourcesSeen,
  }
}

/** True when a run changed nothing at all — used to skip noisy notifications. */
export function isQuietRun(counts: BriefCounts): boolean {
  return (
    counts.created === 0 &&
    counts.updated === 0 &&
    counts.review === 0 &&
    counts.conflicts === 0 &&
    counts.stale === 0
  )
}

function bullets(lines: string[]): string {
  return lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- (none)'
}

/** Render one conflict in the explicit, human-facing form the review flow uses. */
export function formatConflict(c: DetectedConflict): string {
  return [
    'CONFLICT DETECTED',
    '',
    'New source:',
    c.incoming || '(not stated)',
    '',
    'Existing knowledge:',
    c.existing || '(not stated)',
    '',
    'Impact:',
    c.impact || 'Unknown — needs a look.',
    '',
    'Suggested action:',
    c.suggestedAction || 'Confirm which source is current.',
  ].join('\n')
}

/**
 * The change brief: what a compilation run did, in the order a human cares
 * about — what needs them first, then what changed, then what merely grew.
 */
export function formatChangeBrief(input: BriefInput): string {
  const counts = briefCounts(input)
  const parts: string[] = []

  parts.push(`# Change brief — ${input.collectionName}`)
  parts.push(
    `Compiled ${counts.sources} new source${counts.sources === 1 ? '' : 's'} on ${input.startedAt.slice(0, 10)}. ` +
      `${counts.created} page${counts.created === 1 ? '' : 's'} created, ${counts.updated} updated, ` +
      `${counts.review} awaiting review, ${counts.conflicts} conflict${counts.conflicts === 1 ? '' : 's'}.`,
  )

  if (counts.conflicts) {
    parts.push('## Conflicts — needs your decision')
    parts.push(input.conflicts.map(formatConflict).join('\n\n---\n\n'))
  }

  if (counts.review) {
    parts.push('## Held for review')
    parts.push(bullets(input.review.map((r) => `**${r.title}** — ${r.reason}`)))
  }

  parts.push('## Added')
  parts.push(bullets(input.created.map((c) => `**${c.title}** (${c.kind})`)))

  parts.push('## Updated')
  parts.push(bullets(input.updated.map((u) => `**${u.title}** (${u.op})`)))

  if (counts.stale) {
    parts.push('## Now stale')
    parts.push(bullets(input.stale))
  }

  parts.push('## Evidence')
  parts.push(
    `- ${counts.claims} claim${counts.claims === 1 ? '' : 's'} recorded with provenance\n- ${counts.linked} relationship${
      counts.linked === 1 ? '' : 's'
    } linked`,
  )

  if (input.notes) {
    parts.push('## Notes')
    parts.push(input.notes)
  }

  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Compiled-knowledge context block
// ---------------------------------------------------------------------------

/**
 * Render compiled pages as the PRIMARY context block for an agent loop. This is
 * the center-of-gravity shift in one function: the assistant is handed
 * maintained understanding first and told that the raw material following it is
 * evidence, not the answer.
 *
 * Every page that is anything other than plainly current carries an inline flag,
 * because compilation's failure mode is confidence: a compiled page reads as
 * settled truth, so a page that is disputed, has a change queued behind it, or
 * has not been looked at in months must SAY so in the same breath it is quoted.
 */
export function compiledContextBlock(
  collectionName: string,
  pages: CompiledPage[],
  budget = 40_000,
): string {
  const usable = pages.filter((p) => p.status !== 'archived' && (p.content ?? '').trim())
  if (!usable.length) return ''
  // Confirmed pages first, then the most recently maintained.
  const ordered = [...usable].sort((a, b) => {
    if (a.humanConfirmed !== b.humanConfirmed) return a.humanConfirmed ? -1 : 1
    return Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '')
  })
  const chunks: string[] = []
  let used = 0
  for (const p of ordered) {
    // `needs-review` means an update to this page was proposed and the trust
    // boundary declined to apply it unattended — so the page is CURRENT-as-far-
    // as-anyone-approved, but a change is queued behind it. Saying so is the
    // whole point: without this flag the page reads as settled truth while a
    // pending revision sits invisibly in the review queue, and the assistant
    // asserts a fact a human has not yet accepted.
    const flag = p.status === 'contradicted'
      ? ' ⚠ contradicted — treat as disputed'
      : p.status === 'needs-review'
        ? ' ⚠ a proposed update to this page is awaiting review — flag it as possibly out of date'
        : p.status === 'stale'
          ? ' ⚠ stale'
          : p.humanConfirmed
            ? ' ✓ human-confirmed'
            : ''
    const block = `### ${p.title} [${p.kind}]${flag}\n${p.content.trim()}`
    if (used + block.length > budget) break
    chunks.push(block)
    used += block.length
  }
  if (!chunks.length) return ''
  return `# Compiled knowledge — ${collectionName}\n\nThis is the workspace's MAINTAINED understanding of this subject, built from its sources and kept up to date. Answer from this first. Any raw documents that follow are evidence behind these pages, not a substitute for them. If a page is marked contradicted, awaiting review, or stale, say so rather than asserting it as settled.\n\n${chunks.join('\n\n')}`
}
