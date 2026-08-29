// Pure to-do list logic — the collection/done/search filtering and sorting the
// TodosPage renders. Kept out of the component so it can be unit-tested.

export type TodoSortMode = 'manual' | 'due'

// The subset of a to-do the filter/sort actually reads. `todos` rows satisfy it,
// but keeping it minimal makes the helpers trivial to test with plain objects.
export type FilterableTodo = {
  id: string
  title: string
  notes: string
  done: boolean
  due_date: string | null
  position: number
  created_at: string
  /** Lifecycle lane (migration 0116). Absent on rows read by an older client. */
  status?: string | null
  /** Where the to-do came from: 'agent' | 'inbox' | 'api' | null (added by hand). */
  source?: string | null
}

// Case-insensitive substring match against the title and notes — the quick
// search on the To-dos page (complements the global ⌘K search).
export function matchesTodoQuery(todo: { title: string; notes: string }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return todo.title.toLowerCase().includes(q) || (todo.notes ?? '').toLowerCase().includes(q)
}

// Apply the page's filters (collection membership → done → quick search) and,
// in "due" mode, the sort. In "manual" mode the incoming order (position asc,
// created_at desc from the query) is preserved.
// When multiple collections are selected, a to-do is visible if it belongs to
// ANY of them (union, not intersection).
export function filterAndSortTodos<T extends FilterableTodo>(
  todos: T[],
  opts: { memberIds?: Set<string> | null; showDone: boolean; sortMode: TodoSortMode; query?: string },
): T[] {
  let list = todos
  if (opts.memberIds) {
    const set = opts.memberIds
    list = list.filter((t) => set.has(t.id))
  }
  if (!opts.showDone) list = list.filter((t) => !t.done)
  const q = (opts.query ?? '').trim()
  if (q) list = list.filter((t) => matchesTodoQuery(t, q))
  if (opts.sortMode === 'due') {
    list = [...list].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      const av = a.due_date ? new Date(a.due_date).getTime() : Infinity
      const bv = b.due_date ? new Date(b.due_date).getTime() : Infinity
      if (av !== bv) return av - bv
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }
  return list
}

// ---------------------------------------------------------------------------
// Lifecycle status (migration 0116)
//
// `done` stays the boolean every existing surface reads (the REST API, the
// builtins, the Home dashboard, the collections context block). `status` is the
// richer lane a to-do sits in, and the two are kept consistent by a DB trigger
// AND by reconcileStatus() here so an optimistic UI update matches what the row
// will look like once it comes back.
// ---------------------------------------------------------------------------

export type TodoStatus = 'triage' | 'next' | 'doing' | 'blocked' | 'done'

export const TODO_STATUSES: ReadonlyArray<{
  id: TodoStatus
  label: string
  hint: string
  /** Tailwind text/border colour token used for the lane dot. */
  tone: 'info' | 'muted' | 'primary' | 'warn' | 'success'
}> = [
  { id: 'triage', label: 'Triage', hint: 'New, not looked at yet', tone: 'info' },
  { id: 'next', label: 'Next', hint: 'Committed, not started', tone: 'muted' },
  { id: 'doing', label: 'In progress', hint: 'Actively being worked', tone: 'primary' },
  { id: 'blocked', label: 'Blocked', hint: 'Waiting on something', tone: 'warn' },
  { id: 'done', label: 'Done', hint: 'Closed', tone: 'success' },
]

const STATUS_IDS = new Set<string>(TODO_STATUSES.map((s) => s.id))

export function isTodoStatus(v: unknown): v is TodoStatus {
  return typeof v === 'string' && STATUS_IDS.has(v)
}

// Read a row's status defensively: rows written before the migration (or by a
// client that doesn't know the column) fall back to the boolean.
export function statusOf(todo: { status?: string | null; done: boolean }): TodoStatus {
  if (isTodoStatus(todo.status)) return todo.status
  return todo.done ? 'done' : 'triage'
}

// The patch to send when one half of the done/status pair changes. Mirrors the
// DB trigger so the optimistic row equals the persisted one:
//   • status → 'done'          closes it (done + completed_at)
//   • status → anything else   reopens it
//   • done   → true            status becomes 'done'
//   • done   → false           status returns to 'next' (it was committed to,
//                              not re-triaged — un-ticking is a correction)
export function reconcileStatus(
  change: { status: TodoStatus } | { done: boolean },
  current: { status?: string | null; done: boolean },
  now: string = new Date().toISOString(),
): { status: TodoStatus; done: boolean; completed_at: string | null } {
  if ('status' in change) {
    const done = change.status === 'done'
    return { status: change.status, done, completed_at: done ? now : null }
  }
  if (change.done) return { status: 'done', done: true, completed_at: now }
  const prev = statusOf(current)
  return { status: prev === 'done' ? 'next' : prev, done: false, completed_at: null }
}

// ---------------------------------------------------------------------------
// Due-date buckets — the "Time" board's lanes.
// ---------------------------------------------------------------------------

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none'

export const DUE_BUCKETS: ReadonlyArray<{ id: DueBucket; label: string; hint: string }> = [
  { id: 'overdue', label: 'Overdue', hint: 'Past their date' },
  { id: 'today', label: 'Today', hint: 'Due today' },
  { id: 'week', label: 'This week', hint: 'Next seven days' },
  { id: 'later', label: 'Later', hint: 'Beyond next week' },
  { id: 'none', label: 'No date', hint: 'Unscheduled' },
]

const DAY_MS = 86_400_000

// Midnight-local for a `date` column value ("2026-08-28"). Parsing the bare
// string as UTC then rendering it local shifts the day west of Greenwich, which
// is how a to-do due today reads as overdue — hence the explicit T00:00:00.
export function parseDueDate(due: string): Date {
  return new Date(due + 'T00:00:00')
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

// Whole days from today to `due`; negative is in the past.
export function daysUntilDue(due: string, today: Date = new Date()): number {
  return Math.round((startOfDay(parseDueDate(due)).getTime() - startOfDay(today).getTime()) / DAY_MS)
}

export function bucketOf(todo: { due_date: string | null }, today: Date = new Date()): DueBucket {
  if (!todo.due_date) return 'none'
  const n = daysUntilDue(todo.due_date, today)
  if (n < 0) return 'overdue'
  if (n === 0) return 'today'
  if (n <= 7) return 'week'
  return 'later'
}

// A Date as the LOCAL calendar day, in the YYYY-MM-DD shape the `due_date`
// column stores. toISOString() would be wrong here — it converts to UTC first,
// which shifts the day for anyone west of Greenwich.
export function isoDate(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// The ISO date `n` days out — what dropping a card into a due-bucket lane
// reschedules it to.
export function isoDateOffset(days: number, today: Date = new Date()): string {
  const d = startOfDay(today)
  d.setDate(d.getDate() + days)
  return isoDate(d)
}

// Where a card lands when dropped on a bucket lane. 'overdue' is not a
// destination — you can't schedule something into the past on purpose — so the
// lane refuses the drop (null means "no change").
export function dueForBucket(bucket: DueBucket, today: Date = new Date()): string | null | undefined {
  switch (bucket) {
    case 'today':
      return isoDateOffset(0, today)
    case 'week':
      return isoDateOffset(3, today)
    case 'later':
      return isoDateOffset(14, today)
    case 'none':
      return null
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Focus queue — one to-do at a time, hardest-to-ignore first.
// ---------------------------------------------------------------------------

// Overdue → due today → blocked (someone needs a nudge) → agent-filed triage
// (unreviewed work the AI put on your plate) → everything else.
export function focusRank(
  todo: { due_date: string | null; done: boolean; status?: string | null; source?: string | null },
  today: Date = new Date(),
): number {
  if (todo.due_date) {
    const n = daysUntilDue(todo.due_date, today)
    if (n < 0) return 0
    if (n === 0) return 1
  }
  const status = statusOf(todo)
  if (status === 'blocked') return 2
  if (status === 'triage') return todo.source ? 3 : 4
  if (status === 'doing') return 5
  return 6
}

export function focusQueue<T extends FilterableTodo & { status?: string | null; source?: string | null }>(
  todos: T[],
  today: Date = new Date(),
): T[] {
  return todos
    .filter((t) => !t.done)
    .map((t, i) => ({ t, i, rank: focusRank(t, today) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i) // stable: keep list order inside a rank
    .map((x) => x.t)
}

// ---------------------------------------------------------------------------
// Calendar grid — the month the Calendar view paints, Sunday-first, padded to
// whole weeks so the grid is always a clean 7 x N.
// ---------------------------------------------------------------------------

export function monthGrid(month: Date): Array<Date | null> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: Array<Date | null> = []
  for (let i = 0; i < first.getDay(); i++) cells.push(null)
  for (let d = 1; d <= days; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d))
  while (cells.length % 7) cells.push(null)
  return cells
}

export function sameLocalDate(due: string | null, day: Date): boolean {
  if (!due) return false
  return startOfDay(parseDueDate(due)).getTime() === startOfDay(day).getTime()
}
