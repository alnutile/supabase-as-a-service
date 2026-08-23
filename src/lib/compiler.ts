// Browser-side mirror of the knowledge compiler's vocabulary.
//
// The server's judgment lives in supabase/functions/_shared/compiler.ts; this is
// the presentation half — labels, tones, grouping and the policy shape the
// editor writes. It is deliberately pure (no React, no supabase client) so the
// bits that are easy to get subtly wrong — which statuses count as "needs you",
// how a policy round-trips, how a run is summarized — are unit-testable.

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

export const AUTONOMY_LEVELS = ['suggest', 'guarded', 'auto'] as const
export type Autonomy = (typeof AUTONOMY_LEVELS)[number]

export const SOURCE_KINDS = ['file', 'link', 'message', 'artifact', 'todo', 'meeting', 'note'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** What each page kind is for, shown next to the filter chips. */
export const KIND_LABELS: Record<PageKind, string> = {
  concept: 'Concepts',
  decision: 'Decisions',
  process: 'Processes',
  person: 'People',
  project: 'Projects',
  terminology: 'Terminology',
  principle: 'Principles',
  question: 'Open questions',
  profile: 'Profiles',
}

/** Plain-English explanation of each autonomy level, for the policy editor. */
export const AUTONOMY_HELP: Record<Autonomy, string> = {
  suggest: 'Nothing is written unattended. Every proposed change waits for you.',
  guarded: 'New pages and additive updates apply. Rewrites wait for you.',
  auto: 'Rewrites apply too. Replacing a page wholesale still waits for you.',
}

export type Tone = 'neutral' | 'good' | 'warn' | 'danger'

/** How a page status should read at a glance. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'confirmed':
      return 'good'
    case 'contradicted':
      return 'danger'
    case 'stale':
    case 'needs-review':
      return 'warn'
    default:
      return 'neutral'
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'needs-review':
      return 'Needs review'
    case 'contradicted':
      return 'Contradicted'
    case 'confirmed':
      return 'Confirmed'
    case 'stale':
      return 'Stale'
    case 'processing':
      return 'Compiling'
    case 'archived':
      return 'Archived'
    default:
      return 'Compiled'
  }
}

/**
 * Does this page want a human? Contradicted and needs-review pages are asking a
 * question; a stale page is only aging. Used to size the "needs you" badge, so
 * it must not cry wolf.
 */
export function needsAttention(status: string): boolean {
  return status === 'contradicted' || status === 'needs-review'
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface UiPolicy {
  enabled: boolean
  autonomy: Autonomy
  compileSources: SourceKind[]
  maintainKinds: PageKind[]
  neverAuto: string[]
  minConfidence: number
  staleDays: number
}

export const DEFAULT_UI_POLICY: UiPolicy = {
  enabled: true,
  autonomy: 'guarded',
  compileSources: ['file', 'link', 'message', 'artifact', 'meeting', 'note'],
  maintainKinds: ['concept', 'decision', 'process', 'person', 'project', 'terminology', 'principle', 'question'],
  neverAuto: [],
  minConfidence: 0.5,
  staleDays: 90,
}

function pickList<T extends string>(value: unknown, allowed: readonly T[], fallback: T[]): T[] {
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

/** Read a stored policy blob into the shape the editor binds to. */
export function readPolicy(raw: unknown): UiPolicy {
  const r = (raw ?? {}) as Record<string, unknown>
  const autonomy = String(r.autonomy ?? '').trim().toLowerCase()
  return {
    enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    autonomy: (AUTONOMY_LEVELS as readonly string[]).includes(autonomy)
      ? (autonomy as Autonomy)
      : DEFAULT_UI_POLICY.autonomy,
    compileSources: pickList(r.compile_sources, SOURCE_KINDS, DEFAULT_UI_POLICY.compileSources),
    maintainKinds: pickList(r.maintain_kinds, PAGE_KINDS, DEFAULT_UI_POLICY.maintainKinds),
    neverAuto: Array.isArray(r.never_auto)
      ? (r.never_auto as unknown[]).map((v) => String(v ?? '').trim()).filter(Boolean)
      : [],
    minConfidence: clamp(Number(r.min_confidence ?? DEFAULT_UI_POLICY.minConfidence), 0, 1),
    staleDays: Math.round(clamp(Number(r.stale_days ?? DEFAULT_UI_POLICY.staleDays), 1, 3650)),
  }
}

/** Write the editor's state back to the stored snake_case shape. */
export function writePolicy(p: UiPolicy): Record<string, unknown> {
  return {
    enabled: p.enabled,
    autonomy: p.autonomy,
    compile_sources: p.compileSources,
    maintain_kinds: p.maintainKinds,
    never_auto: p.neverAuto,
    min_confidence: p.minConfidence,
    stale_days: p.staleDays,
  }
}

/** Parse the comma-separated never-auto field into guards. */
export function parseGuards(text: string): string[] {
  return String(text ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s, i, all) => all.indexOf(s) === i)
}

// ---------------------------------------------------------------------------
// Grouping and summaries
// ---------------------------------------------------------------------------

export interface PageLike {
  id: string
  kind: string
  title: string
  status: string
  updated_at: string
}

/**
 * Group compiled pages by kind for the dashboard, in the fixed PAGE_KINDS order
 * so the sections don't reshuffle as pages come and go. Empty kinds are dropped.
 */
export function groupByKind<T extends PageLike>(pages: T[]): Array<{ kind: string; label: string; pages: T[] }> {
  const out: Array<{ kind: string; label: string; pages: T[] }> = []
  for (const kind of PAGE_KINDS) {
    const inKind = pages.filter((p) => p.kind === kind)
    if (inKind.length) out.push({ kind, label: KIND_LABELS[kind], pages: inKind })
  }
  const known = new Set<string>(PAGE_KINDS)
  const other = pages.filter((p) => !known.has(p.kind))
  if (other.length) out.push({ kind: 'other', label: 'Other', pages: other })
  return out
}

export interface RunLike {
  status: string
  counts: Record<string, number> | null
  sources_seen: number
  started_at: string
  error?: string | null
}

/** One-line summary of a compilation run, for the run list. */
export function summarizeRun(run: RunLike): string {
  if (run.status === 'running') return 'Compiling…'
  if (run.status === 'error') return run.error ? `Failed: ${run.error}` : 'Failed'
  const c = run.counts ?? {}
  const bits: string[] = []
  if (c.created) bits.push(`${c.created} created`)
  if (c.updated) bits.push(`${c.updated} updated`)
  if (c.review) bits.push(`${c.review} held`)
  if (c.conflicts) bits.push(`${c.conflicts} conflict${c.conflicts === 1 ? '' : 's'}`)
  if (c.stale) bits.push(`${c.stale} stale`)
  if (!bits.length) return run.sources_seen ? 'No changes' : 'Nothing new to compile'
  return bits.join(' · ')
}

/** How far through its checklist a running pass is (0–1). */
export function runProgress(progress: unknown): number {
  if (!Array.isArray(progress) || !progress.length) return 0
  const steps = progress as Array<{ state?: string }>
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length
  return done / steps.length
}
