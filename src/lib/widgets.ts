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
/** How a `chart` widget draws. bar/line/area are time-series; donut is a
 *  grouped breakdown (implies a `groupBy`). Default is 'bar'. */
export type WidgetViz = 'bar' | 'line' | 'area' | 'donut'

export type WidgetSpec = {
  /** Time filter on the source's timeField. Omitted/'all' = no time filter. */
  window?: WidgetWindow
  /** Restrict to rows owned by the viewer (owner column = me). */
  mine?: boolean
  /** For `todos` only: open vs. done. */
  status?: 'open' | 'done'
  /** For `list` widgets: how many rows (clamped). */
  limit?: number
  /** For `chart` widgets: the drawing style (default 'bar'). */
  viz?: WidgetViz
  /** For `chart` widgets: an allow-listed dimension field to group + count by
   *  (a categorical breakdown) instead of the per-day time series. Validated
   *  against the source's `dimensions` — a stored value is always one of our
   *  own column names, never free-form, so it's safe to pass to `.select()`. */
  groupBy?: string
}

/** A categorical dimension a chart can group by (a low-cardinality column). */
export type DimensionDef = { field: string; label: string }

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
  /** Low-cardinality columns a `chart` may group + count by (allow-listed, so a
   *  stored `groupBy` is always one of these — never free-form). */
  dimensions?: DimensionDef[]
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
    dimensions: [{ field: 'done', label: 'Status' }],
  },
  artifacts: {
    table: 'artifacts',
    label: 'Artifacts',
    ownerField: 'owner_id',
    timeField: 'created_at',
    titleField: 'title',
    subtitleField: 'type',
    dimensions: [{ field: 'type', label: 'Type' }],
  },
  files: {
    table: 'files',
    label: 'Files',
    ownerField: 'owner_id',
    timeField: 'created_at',
    titleField: 'name',
    subtitleField: 'mime_type',
    dimensions: [{ field: 'mime_type', label: 'File type' }],
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
    dimensions: [{ field: 'type', label: 'Type' }],
  },
}

export const WIDGET_KINDS: WidgetKind[] = ['stat', 'list', 'chart']
export const WIDGET_VIZ: WidgetViz[] = ['bar', 'line', 'area', 'donut']

export function isWidgetKind(v: unknown): v is WidgetKind {
  return typeof v === 'string' && (WIDGET_KINDS as string[]).includes(v)
}

export function isWidgetSource(v: unknown): v is WidgetSource {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_SOURCES, v)
}

export function isWidgetViz(v: unknown): v is WidgetViz {
  return typeof v === 'string' && (WIDGET_VIZ as string[]).includes(v)
}

/** The dimension defs a source allows grouping by (empty if none). */
export function widgetDimensions(source: WidgetSource): DimensionDef[] {
  return WIDGET_SOURCES[source].dimensions ?? []
}

/** True if `field` is an allow-listed groupBy dimension for the source. */
export function isWidgetDimension(source: WidgetSource, field: unknown): field is string {
  return typeof field === 'string' && widgetDimensions(source).some((d) => d.field === field)
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
  // groupBy must name one of the source's allow-listed dimensions, else it's
  // dropped (so we never pass an unknown column to the query builder).
  if (isWidgetDimension(source, r.groupBy)) spec.groupBy = r.groupBy
  if (isWidgetViz(r.viz)) {
    // A donut only makes sense as a grouped breakdown; without a groupBy it
    // falls back to the default bar time-series.
    spec.viz = r.viz === 'donut' && !spec.groupBy ? 'bar' : r.viz
  }
  return spec
}

export type CategoryBucket = { key: string; label: string; count: number }

const EMPTY_CATEGORY = 'None'
const OTHER_CATEGORY = 'Other'

/** Pretty label for a raw dimension value (booleans → Open/Done, empty → None). */
export function dimensionValueLabel(source: WidgetSource, field: string, raw: unknown): string {
  if (source === 'todos' && field === 'done') {
    if (raw === true || raw === 'true') return 'Done'
    if (raw === false || raw === 'false') return 'Open'
  }
  const s = raw === null || raw === undefined ? '' : String(raw).trim()
  return s || EMPTY_CATEGORY
}

/**
 * Group rows by a categorical field and count each value, biggest first. Keeps
 * the top `topN` and folds the rest into an "Other" bucket, so a donut/bar never
 * grows unbounded. Pure — the widget does the query, this does the tally.
 */
export function bucketByCategory(
  source: WidgetSource,
  field: string,
  rows: Record<string, unknown>[],
  topN = 8,
): CategoryBucket[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const label = dimensionValueLabel(source, field, row[field])
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const sorted = [...counts.entries()]
    .map(([label, count]) => ({ key: label, label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  if (sorted.length <= topN) return sorted
  const head = sorted.slice(0, topN)
  const rest = sorted.slice(topN).reduce((s, b) => s + b.count, 0)
  return [...head, { key: OTHER_CATEGORY, label: OTHER_CATEGORY, count: rest }]
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
  if (kind === 'chart') {
    if (spec.groupBy) {
      const dim = widgetDimensions(source).find((d) => d.field === spec.groupBy)
      return `${def.label} by ${(dim?.label ?? spec.groupBy).toLowerCase()}`
    }
    return `${def.label} per day (last ${CHART_DAYS} days)`
  }
  return `Latest ${subject}`
}
