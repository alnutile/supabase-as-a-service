import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Database } from '../lib/database.types'
import { BoardView, CalendarView, FocusView, TimeView, type TodoViewProps } from './TodoBoards'

type Todo = Database['public']['Tables']['todos']['Row']

afterEach(cleanup)

// A fixed "today" so bucket boundaries and the calendar never depend on the clock.
const TODAY = new Date(2026, 7, 28) // Fri 28 Aug 2026

function todo(partial: Partial<Todo> & { id: string; title: string }): Todo {
  return {
    owner_id: 'u1',
    notes: '',
    due_date: null,
    done: false,
    status: 'triage',
    source: null,
    completed_at: null,
    position: 0,
    visibility: 'private',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...partial,
  }
}

const TODOS: Todo[] = [
  todo({ id: '1', title: 'Overdue thing', due_date: '2026-08-20', status: 'next' }),
  todo({ id: '2', title: 'Due today thing', due_date: '2026-08-28', status: 'doing' }),
  todo({ id: '3', title: 'Blocked thing', status: 'blocked' }),
  todo({ id: '4', title: 'Agent filed this', status: 'triage', source: 'agent' }),
  todo({ id: '5', title: 'Closed thing', status: 'done', done: true, due_date: '2026-08-10' }),
]

function props(over: Partial<TodoViewProps> = {}): TodoViewProps {
  return {
    todos: TODOS,
    collectionsOf: () => ['SupaNet'],
    onOpen: vi.fn(),
    onSetStatus: vi.fn(),
    onSetDue: vi.fn(),
    today: TODAY,
    ...over,
  }
}

describe('BoardView', () => {
  it('files each to-do into its lane, closed ones included', () => {
    render(<BoardView {...props()} />)
    for (const lane of ['Triage', 'Next', 'In progress', 'Blocked', 'Done']) {
      expect(screen.getByText(lane)).toBeTruthy()
    }
    // The Done lane is the reason the board gets the un-done-filtered set.
    expect(screen.getByText('Closed thing')).toBeTruthy()
  })
})

describe('TimeView', () => {
  it('buckets by due date and drops closed to-dos', () => {
    render(<TimeView {...props()} />)
    expect(screen.getByText('Overdue thing')).toBeTruthy()
    expect(screen.getByText('Due today thing')).toBeTruthy()
    // 'Closed thing' is overdue but done — the time board is about open work.
    expect(screen.queryByText('Closed thing')).toBeNull()
    // Undated open work lands in "No date".
    expect(screen.getByText('Blocked thing')).toBeTruthy()
  })
})

describe('CalendarView', () => {
  it('shows the month and offers the undated pile', () => {
    render(<CalendarView {...props()} />)
    expect(screen.getByText('August 2026')).toBeTruthy()
    // Two open undated to-dos: the blocked one and the agent-filed one.
    expect(screen.getByText('No date (2)')).toBeTruthy()
  })
})

describe('FocusView', () => {
  it('leads with the overdue to-do', () => {
    render(<FocusView {...props()} />)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Overdue thing')
  })

  it('advances past a to-do that stays in the queue after acting on it', () => {
    // "Start it" only changes the lane, so the to-do is still open and would
    // otherwise re-sort straight back to the front.
    render(<FocusView {...props()} />)
    fireEvent.click(screen.getByText('Start it'))
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Due today thing')
  })

  it('puts agent-filed triage ahead of a to-do you wrote yourself', () => {
    render(<FocusView {...props({ todos: [TODOS[3], todo({ id: '9', title: 'Mine', status: 'triage' })] })} />)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Agent filed this')
  })

  it('says so when nothing is open', () => {
    render(<FocusView {...props({ todos: [TODOS[4]] })} />)
    expect(screen.getByText(/the queue is clear/)).toBeTruthy()
  })
})
