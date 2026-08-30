import { describe, expect, it } from 'vitest'
import {
  collectionCount,
  emptyCollectionCount,
  filterCollections,
  toggleId,
  triggerLabel,
} from './collectionPicker'

const cols = [
  { id: 'a', name: 'SupaNet' },
  { id: 'b', name: 'Sponsors' },
  { id: 'c', name: 'Shopping List' },
  { id: 'd', name: 'Empty Bucket' },
]
const counts = { a: 45, b: 66, c: 7, d: 0 }

describe('collectionCount', () => {
  it('is null when the page tracks no counts', () => {
    expect(collectionCount(undefined, 'a')).toBeNull()
  })

  it('reads zero for a collection absent from the map', () => {
    expect(collectionCount({ a: 3 }, 'zzz')).toBe(0)
  })
})

describe('emptyCollectionCount', () => {
  it('counts only the known-empty ones', () => {
    expect(emptyCollectionCount(cols, counts)).toBe(1)
  })

  it('is zero without counts (nothing is known to be empty)', () => {
    expect(emptyCollectionCount(cols, undefined)).toBe(0)
  })
})

describe('filterCollections', () => {
  it('hides empty collections by default', () => {
    expect(filterCollections(cols, { counts }).map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('shows them when asked', () => {
    expect(filterCollections(cols, { counts, showEmpty: true })).toHaveLength(4)
  })

  it('keeps a selected collection visible even when empty', () => {
    const out = filterCollections(cols, { counts, selected: new Set(['d']) })
    expect(out.map((c) => c.id)).toContain('d')
  })

  it('matches names case-insensitively on a substring', () => {
    expect(filterCollections(cols, { query: 'spo', counts }).map((c) => c.id)).toEqual(['b'])
    expect(filterCollections(cols, { query: 'LIST', counts }).map((c) => c.id)).toEqual(['c'])
  })

  it('shows everything when the page has no counts at all', () => {
    expect(filterCollections(cols, {})).toHaveLength(4)
  })

  it('returns nothing for a query that matches nothing', () => {
    expect(filterCollections(cols, { query: 'nope', counts })).toEqual([])
  })
})

describe('toggleId', () => {
  it('adds and removes without mutating the input', () => {
    const start = new Set(['a'])
    const added = toggleId(start, 'b')
    expect([...added].sort()).toEqual(['a', 'b'])
    expect([...start]).toEqual(['a'])
    expect([...toggleId(added, 'a')]).toEqual(['b'])
  })
})

describe('triggerLabel', () => {
  it('names the single pick so you can see which one is on', () => {
    expect(triggerLabel(cols, new Set(['b']))).toBe('Sponsors')
  })

  it('counts beyond one', () => {
    expect(triggerLabel(cols, new Set(['a', 'b']))).toBe('2 collections')
  })

  it('falls back to the generic label when nothing is picked', () => {
    expect(triggerLabel(cols, new Set())).toBe('Collections')
  })

  it('counts a stale id rather than showing a blank name', () => {
    expect(triggerLabel(cols, new Set(['gone']))).toBe('1 collections')
  })
})
