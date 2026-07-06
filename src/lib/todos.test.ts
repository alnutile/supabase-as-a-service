import { describe, expect, it } from 'vitest'
import { filterAndSortTodos, matchesTodoQuery, type FilterableTodo } from './todos'

function todo(partial: Partial<FilterableTodo> & { id: string }): FilterableTodo {
  return {
    title: '',
    notes: '',
    done: false,
    due_date: null,
    position: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

describe('matchesTodoQuery', () => {
  it('matches an empty query against anything', () => {
    expect(matchesTodoQuery({ title: 'Buy milk', notes: '' }, '')).toBe(true)
    expect(matchesTodoQuery({ title: 'Buy milk', notes: '' }, '   ')).toBe(true)
  })

  it('matches the title case-insensitively', () => {
    expect(matchesTodoQuery({ title: 'Buy Milk', notes: '' }, 'milk')).toBe(true)
    expect(matchesTodoQuery({ title: 'Buy Milk', notes: '' }, 'MILK')).toBe(true)
  })

  it('matches against the notes', () => {
    expect(matchesTodoQuery({ title: 'Groceries', notes: 'remember the milk' }, 'milk')).toBe(true)
  })

  it('returns false when neither title nor notes contain the query', () => {
    expect(matchesTodoQuery({ title: 'Groceries', notes: 'bread and eggs' }, 'milk')).toBe(false)
  })
})

describe('filterAndSortTodos', () => {
  const a = todo({ id: 'a', title: 'Alpha', done: false, position: 0 })
  const b = todo({ id: 'b', title: 'Beta', done: true, position: 1 })
  const c = todo({ id: 'c', title: 'Gamma milk', notes: '', done: false, position: 2 })

  it('hides done items unless showDone is set', () => {
    expect(filterAndSortTodos([a, b, c], { showDone: false, sortMode: 'manual' }).map((t) => t.id)).toEqual(['a', 'c'])
    expect(filterAndSortTodos([a, b, c], { showDone: true, sortMode: 'manual' }).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('filters to collection members when memberIds is given', () => {
    const set = new Set(['c'])
    expect(filterAndSortTodos([a, b, c], { memberIds: set, showDone: false, sortMode: 'manual' }).map((t) => t.id)).toEqual([
      'c',
    ])
  })

  it('applies the quick search query', () => {
    expect(filterAndSortTodos([a, b, c], { showDone: false, sortMode: 'manual', query: 'milk' }).map((t) => t.id)).toEqual([
      'c',
    ])
  })

  it('preserves input order in manual mode', () => {
    expect(filterAndSortTodos([c, a], { showDone: false, sortMode: 'manual' }).map((t) => t.id)).toEqual(['c', 'a'])
  })

  it('sorts by due date (soonest first, undated last) in due mode', () => {
    const d1 = todo({ id: 'd1', due_date: '2026-03-01', position: 5 })
    const d2 = todo({ id: 'd2', due_date: '2026-01-15', position: 0 })
    const d3 = todo({ id: 'd3', due_date: null, position: 1 })
    const done = todo({ id: 'done', due_date: '2020-01-01', done: true })
    const out = filterAndSortTodos([d1, d2, d3, done], { showDone: true, sortMode: 'due' }).map((t) => t.id)
    expect(out).toEqual(['d2', 'd1', 'd3', 'done'])
  })
})
