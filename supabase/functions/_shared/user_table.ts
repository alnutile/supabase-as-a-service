// Pure helpers for turning a user table (the Tables feature — real ut_* Postgres
// tables) into readable text for the model, so the Tables grid's chat dock can
// inject "here is the table you're looking at" as primary context. Mirrors
// _shared/card_board.ts (cardsToText) and _shared/whiteboard_scene.ts — kept pure
// and import-side-effect-free so it's unit-testable without a DB.

export interface UserTableColumn {
  key: string
  label: string
  type: string
}

// Columns come off user_tables.columns (jsonb) as a loose array — normalize it to
// the {key,label,type} shape, dropping anything without a usable key.
export function normalizeColumns(raw: unknown): UserTableColumn[] {
  if (!Array.isArray(raw)) return []
  const out: UserTableColumn[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const key = String((c as { key?: unknown }).key ?? '').trim()
    if (!key) continue
    const label = String((c as { label?: unknown }).label ?? key).trim() || key
    const type = String((c as { type?: unknown }).type ?? 'text').trim() || 'text'
    out.push({ key, label, type })
  }
  return out
}

// Render one cell value compactly for the preview grid. Objects → JSON, long
// strings truncated, null/undefined → empty. Keeps each row on one line.
function cellText(value: unknown, max = 60): string {
  if (value === null || value === undefined) return ''
  let s: string
  if (typeof value === 'object') s = JSON.stringify(value)
  else if (typeof value === 'boolean') s = value ? 'true' : 'false'
  else s = String(value)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Render a user table (schema + a preview of its rows) as a readable text block.
 * Columns are listed with their type; rows render as a compact pipe-delimited
 * grid limited to `maxRows` so a big table stays within the context budget.
 */
export function tableToText(
  input: { name: string; columns: unknown; rows: unknown[] },
  maxRows = 50,
): string {
  const cols = normalizeColumns(input.columns)
  const rows = Array.isArray(input.rows) ? input.rows : []
  const lines: string[] = []

  if (cols.length === 0) {
    lines.push('This table has no fields yet.')
    return lines.join('\n')
  }

  // Schema line — what each column is.
  lines.push('Fields: ' + cols.map((c) => `${c.label} (${c.type})`).join(', '))
  lines.push('')

  if (rows.length === 0) {
    lines.push('No rows yet.')
    return lines.join('\n')
  }

  // Header + separator.
  const header = cols.map((c) => c.label)
  lines.push(header.join(' | '))
  lines.push(cols.map(() => '---').join(' | '))

  const shown = rows.slice(0, maxRows)
  for (const r of shown) {
    const rec = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    lines.push(cols.map((c) => cellText(rec[c.key])).join(' | '))
  }

  if (rows.length > shown.length) {
    lines.push('')
    lines.push(`… and ${rows.length - shown.length} more row(s) not shown.`)
  }

  return lines.join('\n')
}
