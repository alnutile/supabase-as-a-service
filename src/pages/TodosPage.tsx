import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { filterAndSortTodos } from '../lib/todos'
import { openDatePicker } from '../lib/datePicker'
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  CloseIcon,
  CollectionIcon,
  DragHandleIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  TodoIcon,
} from '../components/icons'

type Todo = Database['public']['Tables']['todos']['Row']
type Collection = Database['public']['Tables']['collections']['Row']

type SortMode = 'manual' | 'due'

// A date is "overdue" when it's strictly before today (local) and the to-do is open.
function isOverdue(due: string | null, done: boolean): boolean {
  if (!due || done) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return new Date(due + 'T00:00:00').getTime() < today.getTime()
}

function dueLabel(due: string | null): string {
  if (!due) return ''
  const d = new Date(due + 'T00:00:00')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Short form for the compact due pill ("Jul 5" — no year).
function shortDue(due: string): string {
  return new Date(due + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Compact due-date control: a small pill showing the date (or "Due"), with a
// transparent native date input laid over it so a tap opens the picker. Much
// smaller than a full date field — the fix for cramped mobile rows.
function DuePill({ due, overdue, onChange }: { due: string | null; overdue: boolean; onChange: (d: string) => void }) {
  return (
    <label
      title={due ? `Due ${dueLabel(due)}` : 'Set a due date'}
      className={`relative inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
        overdue ? 'bg-red-500/15 text-red-500' : due ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-faint hover:text-muted'
      }`}
    >
      <CalendarIcon className="h-3 w-3 shrink-0" />
      <span>{due ? shortDue(due) : 'Due'}</span>
      <input
        type="date"
        value={due ?? ''}
        onChange={(e) => onChange(e.target.value)}
        // Open the picker deterministically instead of trusting the browser's
        // flaky click-to-open on a transparent overlaid input (see openDatePicker).
        onClick={(e) => openDatePicker(e.currentTarget)}
        aria-label="Set a due date"
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
  )
}

export default function TodosPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  // The open to-do lives in the URL (/todos/:todoId) so it's bookmarkable, back
  // works, and the global ⌘K search can deep-link straight to a to-do.
  const { todoId } = useParams()
  const [todos, setTodos] = useState<Todo[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [members, setMembers] = useState<Record<string, Set<string>>>({}) // collection_id -> todo ids
  const [loading, setLoading] = useState(true)

  const [quickTitle, setQuickTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('manual')
  const [showDone, setShowDone] = useState(false)
  const [activeCollection, setActiveCollection] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [tRes, cRes, mRes] = await Promise.all([
      supabase.from('todos').select('*').order('position', { ascending: true }).order('created_at', { ascending: false }),
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('collection_todos').select('collection_id, todo_id'),
    ])
    setTodos(tRes.data ?? [])
    setCollections(cRes.data ?? [])
    const map: Record<string, Set<string>> = {}
    for (const row of mRes.data ?? []) {
      const set = (map[row.collection_id] ??= new Set())
      set.add(row.todo_id)
    }
    setMembers(map)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selectedIds = useMemo(() => [...selected], [selected])

  // The visible list: collection filter → done filter → quick search → sort.
  const visible = useMemo(
    () =>
      filterAndSortTodos(todos, {
        memberIds: activeCollection ? members[activeCollection] ?? new Set<string>() : null,
        showDone,
        sortMode,
        query: search,
      }),
    [todos, members, activeCollection, showDone, sortMode, search],
  )

  // Drag reorder only makes sense over the raw manual order, not a searched subset.
  const dragEnabled = sortMode === 'manual' && !search.trim()

  const openCount = useMemo(() => todos.filter((t) => !t.done).length, [todos])

  // --- mutations -----------------------------------------------------------

  async function addQuick() {
    const title = quickTitle.trim()
    if (!title || !user || adding) return
    setAdding(true)
    // New items go to the top: a position below the current minimum.
    const minPos = todos.length ? Math.min(...todos.map((t) => t.position)) : 0
    const { data, error } = await supabase
      .from('todos')
      .insert({ owner_id: user.id, title, position: minPos - 1, visibility: 'private' })
      .select('*')
      .single()
    setAdding(false)
    if (!error && data) {
      setTodos((prev) => [data, ...prev])
      setQuickTitle('')
      // If filtering by a collection, file the new to-do into it so it shows up.
      if (activeCollection) {
        await supabase.from('collection_todos').upsert(
          { collection_id: activeCollection, todo_id: data.id, added_by: user.id },
          { onConflict: 'collection_id,todo_id', ignoreDuplicates: true },
        )
        setMembers((prev) => {
          const set = new Set(prev[activeCollection] ?? [])
          set.add(data.id)
          return { ...prev, [activeCollection]: set }
        })
      }
    }
  }

  async function patchTodo(id: string, patch: Partial<Todo>) {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    await supabase.from('todos').update(patch).eq('id', id)
  }

  function toggleDone(t: Todo) {
    patchTodo(t.id, { done: !t.done, completed_at: t.done ? null : new Date().toISOString() })
  }

  function toggleVisibility(t: Todo) {
    patchTodo(t.id, { visibility: t.visibility === 'workspace' ? 'private' : 'workspace' })
  }

  async function deleteTodo(id: string) {
    setTodos((prev) => prev.filter((t) => t.id !== id))
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    await supabase.from('todos').delete().eq('id', id)
  }

  // Reflect an edit the detail modal already persisted, so the list matches
  // without a full reload. If the row isn't loaded yet, the merge is a no-op
  // and load() will pick it up.
  function syncTodoInList(id: string, patch: Partial<Todo>) {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  const openTodo = useCallback((id: string) => navigate(`/todos/${id}`), [navigate])
  const closeTodo = useCallback(() => navigate('/todos'), [navigate])

  // Drag reorder (manual mode): reassign sequential positions to the visible set.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIndex = visible.findIndex((t) => t.id === active.id)
    const newIndex = visible.findIndex((t) => t.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const reordered = arrayMove(visible, oldIndex, newIndex)
    // Assign positions 0..n following the new order, then merge into state.
    const posById = new Map(reordered.map((t, i) => [t.id, i]))
    setTodos((prev) =>
      [...prev]
        .map((t) => (posById.has(t.id) ? { ...t, position: posById.get(t.id)! } : t))
        .sort((a, b) => a.position - b.position || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    )
    await Promise.all(reordered.map((t, i) => supabase.from('todos').update({ position: i }).eq('id', t.id)))
  }

  // --- collection tagging (mirrors ArtifactsPage) --------------------------

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearSelection() {
    setSelected(new Set())
    setShowAdd(false)
  }

  function allSelectedIn(cid: string): boolean {
    const set = members[cid] ?? new Set()
    return selectedIds.length > 0 && selectedIds.every((id) => set.has(id))
  }

  async function toggleMembership(cid: string) {
    if (!selectedIds.length || busy || !user) return
    setBusy(true)
    const adding = !allSelectedIn(cid)
    try {
      if (adding) {
        await supabase.from('collection_todos').upsert(
          selectedIds.map((todo_id) => ({ collection_id: cid, todo_id, added_by: user.id })),
          { onConflict: 'collection_id,todo_id', ignoreDuplicates: true },
        )
      } else {
        await supabase.from('collection_todos').delete().eq('collection_id', cid).in('todo_id', selectedIds)
      }
      setMembers((prev) => {
        const next = { ...prev }
        const set = new Set(next[cid] ?? [])
        for (const id of selectedIds) {
          if (adding) set.add(id)
          else set.delete(id)
        }
        next[cid] = set
        return next
      })
    } finally {
      setBusy(false)
    }
  }

  async function createCollection() {
    const name = newName.trim()
    if (!name || busy || !user) return
    setBusy(true)
    try {
      const { data, error } = await supabase
        .from('collections')
        .insert({ owner_id: user.id, name, visibility: 'private' })
        .select()
        .single()
      if (error || !data) return
      setCollections((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
      setNewName('')
      if (selectedIds.length) {
        await supabase.from('collection_todos').upsert(
          selectedIds.map((todo_id) => ({ collection_id: data.id, todo_id, added_by: user.id })),
          { onConflict: 'collection_id,todo_id', ignoreDuplicates: true },
        )
        setMembers((prev) => ({ ...prev, [data.id]: new Set(selectedIds) }))
      }
    } finally {
      setBusy(false)
    }
  }

  async function removeFromActive(todoId: string) {
    if (!activeCollection) return
    await supabase.from('collection_todos').delete().eq('collection_id', activeCollection).eq('todo_id', todoId)
    setMembers((prev) => {
      const set = new Set(prev[activeCollection] ?? [])
      set.delete(todoId)
      return { ...prev, [activeCollection]: set }
    })
  }

  // --- render --------------------------------------------------------------

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-text">
              <TodoIcon className="h-6 w-6 text-muted" /> To-dos
            </h1>
            <p className="mt-1 text-sm text-muted">
              {openCount} open · drag to reorder, set due dates, file into collections.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <div className="flex overflow-hidden rounded-lg border border-border">
              <button
                onClick={() => setSortMode('manual')}
                className={`px-3 py-1.5 font-medium transition ${
                  sortMode === 'manual' ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-hover'
                }`}
              >
                Manual
              </button>
              <button
                onClick={() => setSortMode('due')}
                className={`border-l border-border px-3 py-1.5 font-medium transition ${
                  sortMode === 'due' ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-hover'
                }`}
              >
                Due date
              </button>
            </div>
            <button
              onClick={() => setShowDone((v) => !v)}
              className={`rounded-lg border px-3 py-1.5 font-medium transition ${
                showDone ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              {showDone ? 'Hiding done off' : 'Show done'}
            </button>
          </div>
        </div>

        {/* Quick add */}
        <div className="mt-5 flex items-center gap-2">
          <input
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addQuick()
              }
            }}
            placeholder="Add a to-do and press Enter…"
            className="flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
          />
          <button
            onClick={addQuick}
            disabled={!quickTitle.trim() || adding}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" /> Add
          </button>
        </div>

        {/* Quick search — complements the global ⌘K search, scoped to this page */}
        <div className="relative mt-3">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search to-dos…"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-9 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Collection filter bar */}
        {collections.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveCollection(null)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                activeCollection === null
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              All ({todos.length})
            </button>
            {collections.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCollection(c.id)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                  activeCollection === c.id
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-muted hover:bg-surface-hover'
                }`}
              >
                <CollectionIcon className="h-3.5 w-3.5" />
                {c.name} ({(members[c.id] ?? new Set()).size})
              </button>
            ))}
          </div>
        )}

        {/* List */}
        <div className="mt-5">
          {loading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted">
              {search.trim()
                ? `No to-dos match “${search.trim()}”.`
                : activeCollection
                  ? 'No to-dos in this collection yet.'
                  : 'Nothing here yet — add your first to-do above.'}
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={visible.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <ul className="space-y-1.5">
                  {visible.map((t) => (
                    <TodoRow
                      key={t.id}
                      todo={t}
                      dragDisabled={!dragEnabled}
                      selected={selected.has(t.id)}
                      onToggleSelect={() => toggleSelect(t.id)}
                      onToggleDone={() => toggleDone(t)}
                      onToggleVisibility={() => toggleVisibility(t)}
                      onOpen={() => openTodo(t.id)}
                      onChangeTitle={(title) => title.trim() && title !== t.title && patchTodo(t.id, { title: title.trim() })}
                      onChangeDue={(due) => patchTodo(t.id, { due_date: due || null })}
                      onDelete={() => deleteTodo(t.id)}
                      onRemoveFromCollection={activeCollection ? () => removeFromActive(t.id) : undefined}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      {/* Floating "add to collection" bar */}
      {selected.size > 0 && (
        <div className="pointer-events-none sticky bottom-0 left-0 right-0 z-20 flex justify-center px-4 pb-6">
          <div className="pointer-events-auto relative flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-2.5 shadow-lg">
            <span className="text-sm font-medium text-text">{selected.size} selected</span>
            <button
              onClick={() => setShowAdd((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-primary-strong"
            >
              <CollectionIcon className="h-4 w-4" /> Add to collection
            </button>
            <button onClick={clearSelection} className="text-sm text-muted hover:text-text">
              Clear
            </button>

            {showAdd && (
              <div className="absolute bottom-full left-0 mb-2 max-h-72 w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-xl">
                {collections.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-muted">No collections yet — create one below.</p>
                )}
                {collections.map((c) => {
                  const all = allSelectedIn(c.id)
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleMembership(c.id)}
                      disabled={busy}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-text hover:bg-surface-hover disabled:opacity-50"
                    >
                      <span
                        className={`flex h-4 w-4 items-center justify-center rounded border ${
                          all ? 'border-primary bg-primary text-white' : 'border-border-strong text-transparent'
                        }`}
                      >
                        <CheckIcon className="h-3 w-3" />
                      </span>
                      <CollectionIcon className="h-3.5 w-3.5 text-muted" />
                      <span className="truncate">{c.name}</span>
                    </button>
                  )
                })}
                <div className="flex items-center gap-1.5 border-t border-border px-1.5 pt-1.5">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        createCollection()
                      }
                    }}
                    placeholder="New collection…"
                    className="min-w-0 flex-1 rounded-md border border-border-strong px-2 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
                  />
                  <button
                    onClick={createCollection}
                    disabled={!newName.trim() || busy}
                    className="shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* URL-addressed to-do detail (opened from a row, a collection, or the
          global search — /todos/:todoId) */}
      {todoId && (
        <TodoDetailModal
          key={todoId}
          todoId={todoId}
          onClose={closeTodo}
          onPatched={syncTodoInList}
          onDeleted={(id) => {
            deleteTodo(id)
            closeTodo()
          }}
        />
      )}
    </div>
  )
}

function TodoRow({
  todo,
  dragDisabled,
  selected,
  onToggleSelect,
  onToggleDone,
  onToggleVisibility,
  onOpen,
  onChangeTitle,
  onChangeDue,
  onDelete,
  onRemoveFromCollection,
}: {
  todo: Todo
  dragDisabled: boolean
  selected: boolean
  onToggleSelect: () => void
  onToggleDone: () => void
  onToggleVisibility: () => void
  onOpen: () => void
  onChangeTitle: (title: string) => void
  onChangeDue: (due: string) => void
  onDelete: () => void
  onRemoveFromCollection?: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: todo.id,
    disabled: dragDisabled,
  })
  const [title, setTitle] = useState(todo.title)
  useEffect(() => setTitle(todo.title), [todo.title])

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  const overdue = isOverdue(todo.due_date, todo.done)

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`group flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border bg-surface px-2.5 py-2 md:flex-nowrap ${
        selected ? 'border-primary' : 'border-border'
      }`}
    >
      {/* Drag handle — desktop only (touch drag is fiddly; use the sort toggles) */}
      <button
        {...attributes}
        {...listeners}
        disabled={dragDisabled}
        aria-label="Drag to reorder"
        className={`hidden shrink-0 cursor-grab text-faint hover:text-muted active:cursor-grabbing md:block ${
          dragDisabled ? 'md:invisible' : ''
        }`}
      >
        <DragHandleIcon className="h-4 w-4" />
      </button>

      {/* Complete checkbox */}
      <button
        onClick={onToggleDone}
        aria-label={todo.done ? 'Mark not done' : 'Mark done'}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${
          todo.done ? 'border-primary bg-primary text-white' : 'border-border-strong text-transparent hover:border-primary'
        }`}
      >
        <CheckIcon className="h-3.5 w-3.5" />
      </button>

      {/* Title (inline editable) — owns the whole first line on mobile */}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => onChangeTitle(title)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className={`min-w-0 flex-1 bg-transparent text-sm outline-none ${
          todo.done ? 'text-faint line-through' : 'text-text'
        }`}
      />

      {/* Meta row: due + visibility + actions. Wraps to its own line on mobile
          (w-full) and stays inline on desktop (md:w-auto). */}
      <div className="order-last flex w-full items-center gap-2 md:order-none md:w-auto">
        <DuePill due={todo.due_date} overdue={overdue} onChange={onChangeDue} />

        <button
          onClick={onToggleVisibility}
          title={todo.visibility === 'workspace' ? 'Shared with the workspace' : 'Private to you'}
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition ${
            todo.visibility === 'workspace' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-faint hover:text-muted'
          }`}
        >
          {todo.visibility === 'workspace' ? 'Team' : 'Mine'}
        </button>

        {/* Actions — always visible on mobile (no hover), reveal on hover on desktop */}
        <div className="ml-auto flex shrink-0 items-center gap-1 opacity-100 transition md:ml-0 md:opacity-0 md:group-hover:opacity-100">
          <button
            onClick={onOpen}
            title="Open"
            aria-label="Open to-do"
            className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-primary"
          >
            <ArrowRightIcon className="h-4 w-4" />
          </button>
          {onRemoveFromCollection && (
            <button
              onClick={onRemoveFromCollection}
              title="Remove from this collection"
              className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-muted"
            >
              <CollectionIcon className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onToggleSelect}
            title="Select"
            className={`rounded-md p-1 hover:bg-surface-hover ${selected ? 'text-primary' : 'text-faint hover:text-muted'}`}
          >
            <CheckIcon className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            title="Delete"
            className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-red-600"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// To-do detail — a URL-addressed modal (/todos/:todoId). Opened from a row's
// "Open" button, a collection item, or the global ⌘K search, so a link points
// straight at the to-do and back returns to the list. Self-fetches its row
// (the deep-link case where the page just loaded), edits it in place, and
// syncs the persisted change back into the list via onPatched — no reload.
// ---------------------------------------------------------------------------
function TodoDetailModal({
  todoId,
  onClose,
  onPatched,
  onDeleted,
}: {
  todoId: string
  onClose: () => void
  onPatched: (id: string, patch: Partial<Todo>) => void
  onDeleted: (id: string) => void
}) {
  const [todo, setTodo] = useState<Todo | null | 'missing'>(null)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    supabase
      .from('todos')
      .select('*')
      .eq('id', todoId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        if (!data) return setTodo('missing')
        setTodo(data)
        setTitle(data.title)
        setNotes(data.notes ?? '')
      })
    return () => {
      cancelled = true
    }
  }, [todoId])

  // Persist an edit + reflect it in the modal and the parent list.
  async function persist(patch: Partial<Todo>) {
    if (!todo || todo === 'missing') return
    setTodo({ ...todo, ...patch })
    onPatched(todoId, patch)
    await supabase.from('todos').update(patch).eq('id', todoId)
  }

  function saveTitle() {
    const t = title.trim()
    if (todo && todo !== 'missing' && t && t !== todo.title) persist({ title: t })
    else if (todo && todo !== 'missing') setTitle(todo.title) // revert empty edit
  }

  function saveNotes() {
    if (todo && todo !== 'missing' && notes !== (todo.notes ?? '')) persist({ notes })
  }

  const overdue = todo && todo !== 'missing' ? isOverdue(todo.due_date, todo.done) : false

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <TodoIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-text">
              {todo === 'missing' ? 'Not found' : todo ? 'To-do' : 'Loading…'}
            </h3>
            {todo && todo !== 'missing' && (
              <p className="mt-0.5 text-xs text-faint">
                {todo.done ? 'Done' : 'Open'}
                {todo.visibility === 'workspace' ? ' · shared' : ' · private'}
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-text" aria-label="Close">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {todo === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : todo === 'missing' ? (
            <p className="text-sm text-muted">This to-do doesn’t exist or you don’t have access to it.</p>
          ) : (
            <div className="space-y-4">
              {/* Title + done */}
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() =>
                    persist({ done: !todo.done, completed_at: todo.done ? null : new Date().toISOString() })
                  }
                  aria-label={todo.done ? 'Mark not done' : 'Mark done'}
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition ${
                    todo.done ? 'border-primary bg-primary text-white' : 'border-border-strong text-transparent hover:border-primary'
                  }`}
                >
                  <CheckIcon className="h-4 w-4" />
                </button>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  placeholder="To-do title"
                  className={`min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-1 text-base font-medium outline-none focus:border-border-strong ${
                    todo.done ? 'text-faint line-through' : 'text-text'
                  }`}
                />
              </div>

              {/* Notes */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={saveNotes}
                  rows={5}
                  placeholder="Add notes…"
                  className="w-full resize-y rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
                />
              </div>

              {/* Due + visibility */}
              <div className="flex flex-wrap items-center gap-2">
                <DuePill due={todo.due_date} overdue={overdue} onChange={(d) => persist({ due_date: d || null })} />
                <button
                  onClick={() => persist({ visibility: todo.visibility === 'workspace' ? 'private' : 'workspace' })}
                  title={todo.visibility === 'workspace' ? 'Shared with the workspace' : 'Private to you'}
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition ${
                    todo.visibility === 'workspace' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-faint hover:text-muted'
                  }`}
                >
                  {todo.visibility === 'workspace' ? 'Team' : 'Mine'}
                </button>
              </div>
            </div>
          )}
        </div>

        {todo && todo !== 'missing' && (
          <div className="flex items-center gap-2 border-t border-border px-5 py-3">
            <button
              onClick={() => {
                if (confirm('Delete this to-do?')) onDeleted(todoId)
              }}
              className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              <TrashIcon className="h-4 w-4" /> Delete
            </button>
            <button
              onClick={onClose}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong"
            >
              Done <ArrowRightIcon className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
