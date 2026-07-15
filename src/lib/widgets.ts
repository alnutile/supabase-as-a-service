// Dashboard widgets — pure spec logic (browser side).
//
// A widget is DB-driven, not code: a `dashboard_widgets` row is
// `{ kind, source, spec }` where the AI (or a form) picks a renderer `kind`
// (stat / list / chart), a `source` from a fixed allow-list of tables, and a
// small declarative `spec` (time window, mine-only, todo status, list length).
// The dashboard executes the query with the ordinary Supabase client, so
// **RLS is the hard security boundary** — a widget can never read another
// user's rows regardless of what spec was stored. This module owns the
// allow-list + spec sanitizing so the same rules validate an AI-authored spec
// and drive the query builder; it is unit-tested in widgets.test.ts.
//
// The Deno builtin (create_widget) mirrors the tiny allow-list to reject a bad
// spec before it's ever persisted (defense in depth); this file is the
// authoritative, tested copy.

export type WidgetKind = 'stat' | 'list' | 'chart'
export type WidgetSource = 'todos' | 'artifacts' | 'files' | 'links' | 'collections' | 'activity'
export type WidgetWindow = 'today' | '7d' | '30d' | 'all'

export type WidgetSpec = {
  /** Time filter on the source's timeField. Omitted/'all' = no time filter. */
  window?: WidgetWindow
  /** Restrict to rows owned by the viewer (owner column = me). */
  mine?: boolean
  /** For `todos` only: open vs. done. */
  status?: 'open' | 'done'
  /** For `list` widgets: how many rows (clamped). */
  limit?: number
}

export type SourceDef = {
  /** Physical table name queried under RLS. */
  table: string
  /** Human label (used in prompts + empty states). */
  label: string
  /** Owner column, for the `mine` filter. */
  ownerField: string
  /** Timestamp column, for the window filter + chart bucketing. */
  timeField: string
  /** Primary text column for a `list` row. */
  titleField: string
  /** Optional secondary text column for a `list` row. */
  subtitleField?: string
  /** Whether a `status` (done) filter applies. */
  supportsStatus?: boolean
}

// The allow-list. Adding a source here is the ONLY way to widen what widgets
// can read — and RLS still gates every row. Keep it to tables with a clear
// title + created_at so all three renderers work.
export const WIDGET_SOURCES: Record<WidgetSource, SourceDef> = {
  todos: {
    table: 'todos',
    label: 'To-dos',
    ownerField: 'owner_id',
    timeField: 'created_at',
    titleField: 'title',
    subtitleField: 'notes',
    supportsStatus: true,
  },
  artifacts: {
    table: 'artifacts',
    label: 'Artifacts',
    ownerField: 'owner_id',
    timeField: 'created_at',
    titleField: 'title',
    subtitleField: 'type',
  },
  files: {
    table: 'files',
    label: 'Files',
    ownerField: 'owner_id',
    timeField: 'created_at',
    titleField: 'name',
    subtitleField: 'mime_type',
  },
  links: {
    table: 'links',
    label: 'Links',
    ownerField: 'owner_id',
    timeField: 'created_at',
    titleField: 'title',
    subtitleField: 'url',
  },
  collections: {
    table: 'collections',
    label: 'Collections',
    ownerField: 'owner_id',
    timeField: 'created_at',
    titleField: 'name',
    subtitleField: 'description',
  },
  activity: {
    table: 'activity_log',
    label: 'Activity',
    ownerField: 'actor_id',
    timeField: 'created_at',
    titleField: 'summary',
    subtitleField: 'type',
  },
}

export const WIDGET_KINDS: WidgetKind[] = ['stat', 'list', 'chart']

export function isWidgetKind(v: unknown): v is WidgetKind {
  return typeof v === 'string' && (WIDGET_KINDS as string[]).includes(v)
}

export function isWidgetSource(v: unknown): v is WidgetSource {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_SOURCES, v)
}

const DEFAULT_LIST_LIMIT = 5
const MAX_LIST_LIMIT = 20

/** Clamp a requested list length to a sane range (default 5, max 20). */
export function clampWidgetLimit(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, v))
}

/** How many trailing days a `chart` widget buckets (fixed for the slice). */
export const CHART_DAYS = 14

/**
 * ISO timestamp for the start of a window relative to `now`, or null for
 * 'all'/unknown (meaning: apply no time filter).
 */
export function windowStartISO(window: WidgetWindow | undefined, now: Date = new Date()): string | null {
  if (!window || window === 'all') return null
  const d = new Date(now)
  if (window === 'today') {
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }
  const days = window === '7d' ? 7 : 30
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

/** Sanitize a raw (possibly AI-authored) spec down to known, safe fields. */
export function normalizeSpec(source: WidgetSource, raw: unknown): WidgetSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const spec: WidgetSpec = {}
  if (r.window === 'today' || r.window === '7d' || r.window === '30d' || r.window === 'all') {
    spec.window = r.window
  }
  if (r.mine === true) spec.mine = true
  if (WIDGET_SOURCES[source].supportsStatus && (r.status === 'open' || r.status === 'done')) {
    spec.status = r.status
  }
  if (r.limit !== undefined) spec.limit = clampWidgetLimit(r.limit)
  return spec
}

const WINDOW_LABEL: Record<WidgetWindow, string> = {
  today: 'today',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  all: 'all time',
}

/** Short human description of what a widget shows (for prompts + a11y). */
export function describeWidget(kind: WidgetKind, source: WidgetSource, spec: WidgetSpec): string {
  const def = WIDGET_SOURCES[source]
  const bits: string[] = []
  if (spec.mine) bits.push('my')
  if (spec.status) bits.push(spec.status)
  bits.push(def.label.toLowerCase())
  if (spec.window && spec.window !== 'all') bits.push(WINDOW_LABEL[spec.window])
  const subject = bits.join(' ')
  if (kind === 'stat') return `Count of ${subject}`
  if (kind === 'chart') return `${def.label} per day (last ${CHART_DAYS} days)`
  return `Latest ${subject}`
}
