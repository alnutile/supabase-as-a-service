import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COL_WIDTH,
  MAX_COL_WIDTH,
  MIN_COL_WIDTH,
  clampColWidth,
  nextSort,
  parseColWidths,
  sortRows,
} from './tableView'

describe('clampColWidth', () => {
  it('clamps to the min/max range and rounds', () => {
    expect(clampColWidth(10)).toBe(MIN_COL_WIDTH)
    expect(clampColWidth(99999)).toBe(MAX_COL_WIDTH)
    expect(clampColWidth(180.6)).toBe(181)
  })
  it('falls back to the default for non-finite input', () => {
    expect(clampColWidth(NaN)).toBe(DEFAULT_COL_WIDTH)
    expect(clampColWidth(Infinity)).toBe(DEFAULT_COL_WIDTH)
  })
})

describe('parseColWidths', () => {
  it('returns {} for null/garbage/arrays', () => {
    expect(parseColWidths(null)).toEqual({})
    expect(parseColWidths('not json')).toEqual({})
    expect(parseColWidths('[1,2,3]')).toEqual({})
  })
  it('keeps only numeric widths and clamps them', () => {
    expect(parseColWidths(JSON.stringify({ a: 200, b: '300', c: 5, d: 5000 }))).toEqual({
      a: 200,
      c: MIN_COL_WIDTH,
      d: MAX_COL_WIDTH,
    })
  })
})

describe('nextSort', () => {
  it('starts a new column ascending', () => {
    expect(nextSort(null, 'name')).toEqual({ key: 'name', dir: 'asc' })
    expect(nextSort({ key: 'age', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' })
  })
  it('cycles asc → desc → cleared on the active column', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' })
    expect(nextSort({ key: 'name', dir: 'desc' }, 'name')).toBeNull()
  })
})

describe('sortRows', () => {
  it('returns the input unchanged when there is no active sort', () => {
    const rows = [{ n: 2 }, { n: 1 }]
    expect(sortRows(rows, null, 'number')).toBe(rows)
  })

  it('sorts numbers numerically, not lexically', () => {
    const rows = [{ n: 10 }, { n: 2 }, { n: 1 }]
    expect(sortRows(rows, { key: 'n', dir: 'asc' }, 'number').map((r) => r.n)).toEqual([1, 2, 10])
    expect(sortRows(rows, { key: 'n', dir: 'desc' }, 'number').map((r) => r.n)).toEqual([10, 2, 1])
  })

  it('sorts dates chronologically', () => {
    const rows = [{ d: '2026-03-01' }, { d: '2026-01-15' }, { d: '2026-02-20' }]
    expect(sortRows(rows, { key: 'd', dir: 'asc' }, 'date').map((r) => r.d)).toEqual([
      '2026-01-15',
      '2026-02-20',
      '2026-03-01',
    ])
  })

  it('sinks empty cells to the bottom regardless of direction', () => {
    const rows = [{ t: 'b' }, { t: null }, { t: 'a' }, { t: '' }]
    expect(sortRows(rows, { key: 't', dir: 'asc' }, 'text').map((r) => r.t)).toEqual([
      'a',
      'b',
      null,
      '',
    ])
    expect(sortRows(rows, { key: 't', dir: 'desc' }, 'text').map((r) => r.t)).toEqual([
      'b',
      'a',
      null,
      '',
    ])
  })

  it('is stable for equal values', () => {
    const rows = [
      { t: 'a', id: 1 },
      { t: 'a', id: 2 },
      { t: 'a', id: 3 },
    ]
    expect(sortRows(rows, { key: 't', dir: 'asc' }, 'text').map((r) => r.id)).toEqual([1, 2, 3])
  })

  it('orders booleans false before true when ascending', () => {
    const rows = [{ b: true }, { b: false }, { b: true }]
    expect(sortRows(rows, { key: 'b', dir: 'asc' }, 'boolean').map((r) => r.b)).toEqual([
      false,
      true,
      true,
    ])
  })

  it('does not mutate the input array', () => {
    const rows = [{ n: 3 }, { n: 1 }, { n: 2 }]
    sortRows(rows, { key: 'n', dir: 'asc' }, 'number')
    expect(rows.map((r) => r.n)).toEqual([3, 1, 2])
  })
})
