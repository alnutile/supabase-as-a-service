// Pure helpers for the public table write-form (`form-submit` edge function).
// Kept out of the function body so the allow-list intersection, type coercion,
// and required-field validation are unit-testable (tests/forms_test.ts) — the
// same "extract the logic, test the module" pattern as validate.ts / artifacts.ts.

export interface FormFieldSpec {
  key: string
  required?: boolean
}

// A user table's column, as stored in user_tables.columns.
export interface TableColumn {
  key: string
  label?: string
  type: string
}

// Coerce a submitted value (which arrives as a string from an HTML form, or as
// loose JSON) into the shape Postgres expects for the column's type. An empty
// string becomes null (a blank optional field). Returns { value } or { error }.
export function coerceValue(type: string, raw: unknown): { value: unknown } | { error: string } {
  // Blank / absent -> null. `false` and `0` are meaningful, so guard those.
  if (raw === undefined || raw === null) return { value: null }
  if (typeof raw === 'string' && raw.trim() === '') return { value: null }

  switch (type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(n)) return { error: 'must be a number' }
      return { value: n }
    }
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: 'must be a whole number' }
      return { value: n }
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw }
      const s = String(raw).trim().toLowerCase()
      if (['true', 'on', 'yes', '1'].includes(s)) return { value: true }
      if (['false', 'off', 'no', '0'].includes(s)) return { value: false }
      return { error: 'must be true or false' }
    }
    case 'date': {
      // Accept an ISO date (YYYY-MM-DD) or anything Date can parse; store the
      // date part only.
      const s = String(raw).trim()
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) return { error: 'must be a valid date' }
      // Keep an already-well-formed YYYY-MM-DD verbatim (avoids TZ drift).
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s }
      return { value: d.toISOString().slice(0, 10) }
    }
    case 'datetime': {
      const s = String(raw).trim()
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) return { error: 'must be a valid date/time' }
      return { value: d.toISOString() }
    }
    case 'json': {
      if (typeof raw === 'object') return { value: raw }
      try {
        return { value: JSON.parse(String(raw)) }
      } catch {
        return { error: 'must be valid JSON' }
      }
    }
    // text, longtext, and anything unknown -> store as text.
    default:
      return { value: typeof raw === 'string' ? raw : String(raw) }
  }
}

// Build the row to insert from a public submission. Intersects the form's
// allow-list (`fields`) with the table's REAL columns, coerces each supplied
// value to its column type, and enforces required fields. Unknown/non-allow-
// listed keys are silently dropped (never written). Returns the safe row plus a
// list of human-readable validation errors (empty = OK to insert).
export function buildSubmissionRow(
  columns: TableColumn[],
  fields: FormFieldSpec[],
  values: Record<string, unknown>,
): { row: Record<string, unknown>; errors: string[] } {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const row: Record<string, unknown> = {}
  const errors: string[] = []
  const vals = values && typeof values === 'object' ? values : {}

  for (const field of fields) {
    const col = byKey.get(field.key)
    // A field that no longer maps to a real column is ignored (never written),
    // but a required one that's gone is a configuration error worth surfacing.
    if (!col) {
      if (field.required) errors.push(`"${field.key}" is no longer a column on this table`)
      continue
    }
    const raw = vals[field.key]
    const supplied = raw !== undefined && !(typeof raw === 'string' && raw.trim() === '') && raw !== null
    if (!supplied) {
      if (field.required) errors.push(`"${col.label || col.key}" is required`)
      continue
    }
    const res = coerceValue(col.type, raw)
    if ('error' in res) {
      errors.push(`"${col.label || col.key}" ${res.error}`)
      continue
    }
    if (res.value !== null) row[col.key] = res.value
  }

  return { row, errors }
}
