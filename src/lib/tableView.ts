import type { UserTableColumnType } from './database.types'

// Pure view-state logic for the Tables grid: column widths (drag-to-resize) and
// row sorting (click-a-header). Kept out of TablesPage so it can be unit-tested —
// the component only wires these into state + localStorage.

// ---------------------------------------------------------------------------
// Column widths (persisted per-table in localStorage as { [key]: px })
// ---------------------------------------------------------------------------
export const MIN_COL_WIDTH = 80
export const MAX_COL_WIDTH = 720
export const DEFAULT_COL_WIDTH = 180

/** Clamp a dragged width to a sane range and snap to whole pixels. */
export function clampColWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_COL_WIDTH
  return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(px)))
}

/** Parse a persisted widths blob, dropping anything that isn't a valid width. */
export function parseColWidths(raw: string | null): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = clampColWidth(value)
    }
    return out
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Sorting (click a header: none → asc → desc → none)
// ---------------------------------------------------------------------------
export type SortDir = 'asc' | 'desc'
export interface SortState {
  key: string
  dir: SortDir
}

/**
 * Next sort state when a header is clicked. Clicking a new column starts at
 * ascending; clicking the active column cycles asc → desc → cleared.
 */
export function nextSort(current: SortState | null, key: string): SortState | null {
  if (!current || current.key !== key) return { key, dir: 'asc' }
  if (current.dir === 'asc') return { key, dir: 'desc' }
  return null
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === ''
}

// Compare two cell values of a given column type. Empty values always sort to
// the bottom regardless of direction (the ascending/descending sign is applied
// by the caller only to non-empty comparisons).
function compareValues(a: unknown, b: unknown, type: UserTableColumnType): number {
  switch (type) {
    case 'number':
    case 'integer': {
      const na = Number(a)
      const nb = Number(b)
      if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b))
      return na - nb
    }
    case 'date':
    case 'datetime': {
      const ta = new Date(String(a)).getTime()
      const tb = new Date(String(b)).getTime()
      if (Number.isNaN(ta) || Number.isNaN(tb)) return String(a).localeCompare(String(b))
      return ta - tb
    }
    case 'boolean':
      return (a === true ? 1 : 0) - (b === true ? 1 : 0)
    case 'json':
      return JSON.stringify(a ?? null).localeCompare(JSON.stringify(b ?? null))
    default:
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  }
}

/**
 * Sort a copy of `rows` by the given column. Empty cells always sink to the
 * bottom; the sort is stable (equal rows keep their original order). Returns
 * the input untouched when there's no active sort.
 */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  sort: SortState | null,
  type: UserTableColumnType,
): T[] {
  if (!sort) return rows
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows]
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const a = x.row[sort.key]
      const b = y.row[sort.key]
      const aEmpty = isEmpty(a)
      const bEmpty = isEmpty(b)
      if (aEmpty && bEmpty) return x.index - y.index
      if (aEmpty) return 1
      if (bEmpty) return -1
      const cmp = sign * compareValues(a, b, type)
      return cmp !== 0 ? cmp : x.index - y.index
    })
    .map((entry) => entry.row)
}
