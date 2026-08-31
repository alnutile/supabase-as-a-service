// Pure formatting for the saved-links (bookmarks) listing.
//
// `list_links` is exposed to the in-app assistant, the agent loops and — via
// the MCP server, which delegates to the same builtin — an external Claude.
// The rendering lives here (rather than inline in builtins.ts) so the shape of
// what a model sees is unit-tested: in particular the timestamps, which let a
// caller answer "what did we save this week" without a second round trip.

export type LinkRow = {
  id: string
  url: string
  title: string
  description: string
  created_at?: string | null
  updated_at?: string | null
}

/** ISO 8601 trimmed to whole seconds (`2026-08-31T14:03:22Z`); '' when unparseable. */
export function isoSeconds(value: string | null | undefined): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toISOString().slice(0, 19)}Z`
}

/**
 * The timestamp line for one link. `updated` is only shown when it differs
 * from `saved` (a link that was never edited would otherwise print the same
 * instant twice).
 */
export function timestampLine(row: LinkRow): string {
  const saved = isoSeconds(row.created_at)
  const updated = isoSeconds(row.updated_at)
  if (!saved && !updated) return ''
  if (!saved) return `updated: ${updated}`
  if (!updated || updated === saved) return `saved: ${saved}`
  return `saved: ${saved} · updated: ${updated}`
}

/** One bullet per link: title/url, a truncated description, the id and dates. */
export function formatLinkList(rows: LinkRow[]): string {
  return rows
    .map((l) => {
      const lines = [`• ${l.title} — ${l.url}`]
      if (l.description) lines.push(`  ${l.description.slice(0, 200)}`)
      const ts = timestampLine(l)
      lines.push(`  id: ${l.id}${ts ? ` · ${ts}` : ''}`)
      return lines.join('\n')
    })
    .join('\n')
}

// --- Date-range filtering ---------------------------------------------------

/**
 * Parse one end of a date range. Accepts a full ISO 8601 timestamp or a bare
 * `YYYY-MM-DD` date; a bare date is widened to cover the whole UTC day, so
 * `until: '2026-08-31'` INCLUDES everything saved that day rather than cutting
 * off at midnight (the difference a model would otherwise get silently wrong).
 * Returns null for an empty value and 'invalid' for anything unparseable.
 */
export function parseDateBound(
  value: unknown,
  edge: 'start' | 'end',
): string | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return 'invalid'
  const raw = value.trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00.000Z`)
    if (Number.isNaN(d.getTime())) return 'invalid'
    return edge === 'start' ? d.toISOString() : `${raw}T23:59:59.999Z`
  }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return 'invalid'
  return d.toISOString()
}

/** Which timestamp a range filters on: when the link was saved, or last changed. */
export function dateColumn(value: unknown): 'created_at' | 'updated_at' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw === 'updated' || raw === 'updated_at' ? 'updated_at' : 'created_at'
}
