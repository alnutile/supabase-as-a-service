import { describe, expect, it } from 'vitest'
import {
  bucketOf,
  daysUntilDue,
  dueForBucket,
  filterAndSortTodos,
  focusQueue,
  focusRank,
  isoDateOffset,
  matchesTodoQuery,
  monthGrid,
  reconcileStatus,
  sameLocalDate,
  statusOf,
  type FilterableTodo,
} from './todos'

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

// A fixed "today" so the bucket/queue maths never depends on the clock.
const TODAY = new Date(2026, 7, 28) // Fri 28 Aug 2026, local

describe('statusOf', () => {
  it('reads the column when it is a known lane', () => {
    expect(statusOf({ status: 'blocked', done: false })).toBe('blocked')
  })

  it('falls back to the boolean for a pre-migration row', () => {
    expect(statusOf({ done: false })).toBe('triage')
    expect(statusOf({ done: true })).toBe('done')
    expect(statusOf({ status: null, done: true })).toBe('done')
  })

  it('ignores a lane it does not recognise', () => {
    expect(statusOf({ status: 'wat', done: false })).toBe('triage')
  })
})

describe('reconcileStatus', () => {
  const now = '2026-08-28T12:00:00.000Z'

  it('closes the to-do when the lane becomes done', () => {
    expect(reconcileStatus({ status: 'done' }, { status: 'doing', done: false }, now)).toEqual({
      status: 'done',
      done: true,
      completed_at: now,
    })
  })

  it('reopens it when the lane moves off done', () => {
    expect(reconcileStatus({ status: 'next' }, { status: 'done', done: true }, now)).toEqual({
      status: 'next',
      done: false,
      completed_at: null,
    })
  })

  it('moves a ticked to-do into the done lane', () => {
    expect(reconcileStatus({ done: true }, { status: 'triage', done: false }, now)).toEqual({
      status: 'done',
      done: true,
      completed_at: now,
    })
  })

  it('treats un-ticking as a correction, landing in Next rather than Triage', () => {
    expect(reconcileStatus({ done: false }, { status: 'done', done: true }, now)).toEqual({
      status: 'next',
      done: false,
      completed_at: null,
    })
  })

  it('keeps a non-done lane when the boolean is cleared on an already-open row', () => {
    expect(reconcileStatus({ done: false }, { status: 'blocked', done: false }, now).status).toBe('blocked')
  })
})

describe('daysUntilDue', () => {
  it('counts whole local days in both directions', () => {
    expect(daysUntilDue('2026-08-28', TODAY)).toBe(0)
    expect(daysUntilDue('2026-08-29', TODAY)).toBe(1)
    expect(daysUntilDue('2026-08-21', TODAY)).toBe(-7)
  })
})

describe('bucketOf', () => {
  it('sorts a date into its lane', () => {
    expect(bucketOf({ due_date: null }, TODAY)).toBe('none')
    expect(bucketOf({ due_date: '2026-08-27' }, TODAY)).toBe('overdue')
    expect(bucketOf({ due_date: '2026-08-28' }, TODAY)).toBe('today')
    expect(bucketOf({ due_date: '2026-09-04' }, TODAY)).toBe('week') // exactly seven days out
    expect(bucketOf({ due_date: '2026-09-05' }, TODAY)).toBe('later')
  })
})

describe('isoDateOffset', () => {
  it('formats a local date and rolls the month over', () => {
    expect(isoDateOffset(0, TODAY)).toBe('2026-08-28')
    expect(isoDateOffset(4, TODAY)).toBe('2026-09-01')
    expect(isoDateOffset(-28, TODAY)).toBe('2026-07-31')
  })
})

describe('dueForBucket', () => {
  it('schedules into the lane you dropped on', () => {
    expect(dueForBucket('today', TODAY)).toBe('2026-08-28')
    expect(dueForBucket('week', TODAY)).toBe('2026-08-31')
    expect(dueForBucket('later', TODAY)).toBe('2026-09-11')
  })

  it('clears the date for the No-date lane', () => {
    expect(dueForBucket('none', TODAY)).toBeNull()
  })

  it('refuses to schedule into the past', () => {
    expect(dueForBucket('overdue', TODAY)).toBeUndefined()
  })
})

describe('focusRank / focusQueue', () => {
  const base = { done: false, due_date: null as string | null }

  it('ranks overdue above today, and today above everything undated', () => {
    expect(focusRank({ ...base, due_date: '2026-08-01' }, TODAY)).toBeLessThan(
      focusRank({ ...base, due_date: '2026-08-28' }, TODAY),
    )
    expect(focusRank({ ...base, due_date: '2026-08-28' }, TODAY)).toBeLessThan(
      focusRank({ ...base, status: 'blocked' }, TODAY),
    )
  })

  it('puts agent-filed triage ahead of a to-do you wrote yourself', () => {
    expect(focusRank({ ...base, status: 'triage', source: 'agent' }, TODAY)).toBeLessThan(
      focusRank({ ...base, status: 'triage', source: null }, TODAY),
    )
  })

  it('drops done to-dos and keeps list order inside a rank', () => {
    const items = [
      todo({ id: 'later', due_date: '2026-12-01' }),
      todo({ id: 'closed', done: true, due_date: '2026-08-01' }),
      todo({ id: 'overdue-b', due_date: '2026-08-02' }),
      todo({ id: 'overdue-a', due_date: '2026-08-01' }),
    ]
    expect(focusQueue(items, TODAY).map((t) => t.id)).toEqual(['overdue-b', 'overdue-a', 'later'])
  })
})

describe('monthGrid', () => {
  it('pads to whole Sunday-first weeks around the real days', () => {
    const cells = monthGrid(TODAY) // August 2026 starts on a Saturday
    expect(cells.length % 7).toBe(0)
    expect(cells.slice(0, 6).every((c) => c === null)).toBe(true)
    expect(cells[6]?.getDate()).toBe(1)
    expect(cells.filter(Boolean)).toHaveLength(31)
  })
})

describe('sameLocalDate', () => {
  it('compares a date column against a calendar cell in local time', () => {
    expect(sameLocalDate('2026-08-28', TODAY)).toBe(true)
    expect(sameLocalDate('2026-08-27', TODAY)).toBe(false)
    expect(sameLocalDate(null, TODAY)).toBe(false)
  })
})
