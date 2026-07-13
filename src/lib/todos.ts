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
