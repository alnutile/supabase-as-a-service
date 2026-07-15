// Dashboard widget spec validation — the Deno mirror of src/lib/widgets.ts.
// Used by the create_widget builtin to reject a malformed / out-of-allow-list
// spec BEFORE it's persisted (defense in depth — the browser also validates,
// and RLS is the real boundary). Pure + unit-tested in tests/widgets_test.ts.

export const WIDGET_KINDS = ['stat', 'list', 'chart'] as const
export const WIDGET_SOURCES = ['todos', 'artifacts', 'files', 'links', 'collections', 'activity'] as const

export type WidgetKind = (typeof WIDGET_KINDS)[number]
export type WidgetSource = (typeof WIDGET_SOURCES)[number]

export type WidgetSpec = {
  window?: 'today' | '7d' | '30d' | 'all'
  mine?: boolean
  status?: 'open' | 'done'
  limit?: number
}

export type ValidWidget = { title: string; kind: WidgetKind; source: WidgetSource; spec: WidgetSpec }

// Only `todos` carries a done/open status.
const STATUS_SOURCES = new Set<WidgetSource>(['todos'])

function clampLimit(n: unknown): number | undefined {
  if (n === undefined || n === null) return undefined
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 5
  return Math.min(20, Math.max(1, v))
}

/**
 * Validate an AI/user-authored widget definition. Returns the sanitized widget
 * or an error string (never throws). Unknown kinds/sources are rejected; the
 * spec is stripped to known, safe fields.
 */
export function validateWidget(input: Record<string, unknown>): ValidWidget | string {
  const title = String(input?.title ?? '').trim()
  if (!title) return 'A widget title is required.'
  const kind = input?.kind
  if (typeof kind !== 'string' || !(WIDGET_KINDS as readonly string[]).includes(kind)) {
    return `kind must be one of: ${WIDGET_KINDS.join(', ')}.`
  }
  const source = input?.source
  if (typeof source !== 'string' || !(WIDGET_SOURCES as readonly string[]).includes(source)) {
    return `source must be one of: ${WIDGET_SOURCES.join(', ')}.`
  }
  const raw = (input?.spec && typeof input.spec === 'object' ? input.spec : {}) as Record<string, unknown>
  const spec: WidgetSpec = {}
  if (raw.window === 'today' || raw.window === '7d' || raw.window === '30d' || raw.window === 'all') {
    spec.window = raw.window
  }
  if (raw.mine === true) spec.mine = true
  if (STATUS_SOURCES.has(source as WidgetSource) && (raw.status === 'open' || raw.status === 'done')) {
    spec.status = raw.status
  }
  const lim = clampLimit(raw.limit)
  if (lim !== undefined) spec.limit = lim
  return { title: title.slice(0, 80), kind: kind as WidgetKind, source: source as WidgetSource, spec }
}
