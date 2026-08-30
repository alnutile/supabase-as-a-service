import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { Database, TodoStatus } from '../lib/database.types'
import {
  DUE_BUCKETS,
  TODO_STATUSES,
  bucketOf,
  daysUntilDue,
  dueForBucket,
  focusQueue,
  isoDate,
  isoDateOffset,
  monthGrid,
  parseDueDate,
  sameLocalDate,
  statusOf,
  type DueBucket,
} from '../lib/todos'
import { AgentIcon, ApiIcon, ArrowRightIcon, CalendarIcon, CheckIcon, CollectionIcon, InboxIcon, PlayIcon } from './icons'

type Todo = Database['public']['Tables']['todos']['Row']

/** What every view needs from the page: the rows, their collections, and the writes. */
export type TodoViewProps = {
  todos: Todo[]
  /** Collection names a to-do is filed into — rendered as tokens on the card. */
  collectionsOf: (todoId: string) => string[]
  onOpen: (id: string) => void
  onSetStatus: (id: string, status: TodoStatus) => void
  onSetDue: (id: string, due: string | null) => void
  onToggleDone: (id: string) => void
  /** Ids another session just changed, so the move is visible rather than silent. */
  remoteIds: ReadonlySet<string>
  /** Fixed "today" — passed in so every lane in one render agrees on the date. */
  today: Date
}

const TONE_DOT: Record<string, string> = {
  info: 'bg-info',
  muted: 'bg-faint',
  primary: 'bg-primary',
  warn: 'bg-warn',
  success: 'bg-success',
}

// ---------------------------------------------------------------------------
// Card furniture
// ---------------------------------------------------------------------------

export function DueChip({ due, done, today }: { due: string | null; done: boolean; today: Date }) {
  if (!due) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-faint">
        <CalendarIcon className="h-3 w-3" /> No date
      </span>
    )
  }
  const n = daysUntilDue(due, today)
  const label = n === 0 ? 'Today' : parseDueDate(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (done) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-faint">
        <CheckIcon className="h-3 w-3" /> {label}
      </span>
    )
  }
  const cls =
    n < 0
      ? 'bg-red-500/15 text-red-500 px-2 py-0.5'
      : n === 0
        ? 'bg-primary-soft text-primary px-2 py-0.5'
        : 'text-muted'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full text-[11px] font-bold ${cls}`}>
      <CalendarIcon className="h-3 w-3" /> {label}
    </span>
  )
}

/** Where the to-do came from. Only rendered when something other than a person filed it. */
export function SourceTag({ source }: { source: string | null }) {
  if (!source) return null
  const Icon = source === 'agent' ? AgentIcon : source === 'inbox' ? InboxIcon : ApiIcon
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-info">
      <Icon className="h-2.5 w-2.5" /> {source}
    </span>
  )
}

function MiniToken({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-[10rem] items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">
      <CollectionIcon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
}

function TodoCard({
  todo,
  collections,
  onOpen,
  onToggleDone,
  today,
  draggable = true,
  /** Rendered inside the DragOverlay: a static copy, never a drag source itself. */
  overlay = false,
  /** Someone else just changed this row — flash it so the move is noticed. */
  remote = false,
}: {
  todo: Todo
  collections: string[]
  onOpen: () => void
  onToggleDone?: () => void
  today: Date
  draggable?: boolean
  overlay?: boolean
  remote?: boolean
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: todo.id,
    disabled: !draggable || overlay,
  })
  // The whole card is the drag surface — a 16px handle was undiscoverable, and
  // worse, it looked exactly like the checkbox it sat next to. The pointer
  // sensor's 4px activation constraint keeps a plain click a click, so the
  // title still opens the to-do and the checkbox still ticks it.
  // No transform is applied here: the DragOverlay renders the moving copy, so
  // the card being dragged stays put and just dims.
  // Where the pointer went down on this card, so a click that followed a drag
  // doesn't also open the to-do. The title must stay draggable — it's the
  // biggest target on the card — so blocking pointerdown there is not an option.
  const down = useRef<{ x: number; y: number } | null>(null)
  const openIfNotDragged = (e: React.MouseEvent) => {
    const from = down.current
    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) return
    onOpen()
  }

  return (
    <article
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : attributes)}
      {...(overlay ? {} : listeners)}
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY }
        listeners?.onPointerDown?.(e)
      }}
      className={`group flex flex-col gap-2 rounded-xl border bg-surface p-3 text-left shadow-soft transition ${
        draggable && !overlay ? 'cursor-grab active:cursor-grabbing' : ''
      } ${
        overlay
          ? 'rotate-2 border-primary shadow-soft-lg'
          : isDragging
            ? 'border-primary opacity-40'
            : remote
              ? 'border-info ring-2 ring-info/40'
              : 'border-border hover:border-border-strong hover:shadow-soft-lg'
      }`}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={onToggleDone}
          // Stop the pointer here so ticking a to-do can never start a drag.
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!onToggleDone}
          aria-label={todo.done ? 'Mark not done' : 'Mark done'}
          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
            todo.done ? 'border-primary bg-primary text-white' : 'border-border-strong text-transparent hover:border-primary'
          }`}
        >
          <CheckIcon className="h-3 w-3" />
        </button>
        <span
          onClick={openIfNotDragged}
          className="min-w-0 flex-1 cursor-pointer text-sm font-semibold leading-snug text-text hover:text-primary"
        >
          {todo.title}
        </span>
      </div>
      {todo.notes && <p className="ml-6 line-clamp-2 text-xs leading-relaxed text-muted">{todo.notes}</p>}
      <div className="ml-6 flex flex-wrap items-center gap-2">
        {collections.slice(0, 2).map((name) => (
          <MiniToken key={name} name={name} />
        ))}
        {collections.length > 2 && <span className="text-[11px] font-semibold text-faint">+{collections.length - 2}</span>}
        <DueChip due={todo.due_date} done={todo.done} today={today} />
        <SourceTag source={todo.source} />
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Lane boards (status and due-date), which differ only in how they group.
// ---------------------------------------------------------------------------

function Lane({
  id,
  title,
  hint,
  dot,
  count,
  children,
  droppable = true,
}: {
  id: string
  title: string
  hint: string
  dot: string
  count: number
  children: React.ReactNode
  droppable?: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable })
  return (
    <section
      ref={setNodeRef}
      className={`flex min-h-[12rem] min-w-0 flex-col rounded-2xl border transition xl:min-h-0 ${
        isOver && droppable ? 'border-primary-soft-border bg-primary-soft' : 'border-border bg-surface-2'
      }`}
    >
      <header className="flex items-center gap-2 px-3 pb-1.5 pt-3">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <h3 className="flex-1 truncate text-[13px] font-bold text-text">{title}</h3>
        <span className="text-xs font-bold text-faint">{count}</span>
      </header>
      <p className="px-3 pb-2 text-[11px] text-faint">{hint}</p>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
        {children}
        {count === 0 && <p className="py-4 text-center text-xs text-faint">Nothing here.</p>}
      </div>
    </section>
  )
}

function LaneBoard({
  lanes,
  props,
  onDrop,
}: {
  lanes: Array<{ id: string; label: string; hint: string; dot: string; items: Todo[]; droppable?: boolean }>
  props: TodoViewProps
  onDrop: (todoId: string, laneId: string) => void
}) {
  // Pointer drag needs a 4px threshold so a plain click stays a click. The
  // keyboard sensor is not optional decoration: dnd-kit's `attributes` put
  // role="button" and tabIndex on every card, which promises a keyboard user
  // they can move it — registering the sensor is what makes that true.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )
  const [dragging, setDragging] = useState<string | null>(null)
  const active = dragging ? props.todos.find((t) => t.id === dragging) : null
  function onDragEnd(e: DragEndEvent) {
    setDragging(null)
    if (e.over) onDrop(String(e.active.id), String(e.over.id))
  }
  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-2 xl:grid-cols-5 xl:overflow-hidden">
        {lanes.map((lane) => (
          <Lane
            key={lane.id}
            id={lane.id}
            title={lane.label}
            hint={lane.hint}
            dot={lane.dot}
            count={lane.items.length}
            droppable={lane.droppable}
          >
            {lane.items.map((t) => (
              <TodoCard
                key={t.id}
                todo={t}
                collections={props.collectionsOf(t.id)}
                onOpen={() => props.onOpen(t.id)}
                onToggleDone={() => props.onToggleDone(t.id)}
                remote={props.remoteIds.has(t.id)}
                today={props.today}
              />
            ))}
          </Lane>
        ))}
      </div>
      {/* The overlay renders the moving card in a portal, so it floats over the
          lane borders instead of being clipped by each lane's own scroll box —
          without it a cross-lane drag looks broken even when it works. */}
      <DragOverlay dropAnimation={null}>
        {active ? (
          <TodoCard
            todo={active}
            collections={props.collectionsOf(active.id)}
            onOpen={() => {}}
            today={props.today}
            overlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

/** Status lanes — drag a card to change what state it's in. */
export function BoardView(props: TodoViewProps) {
  const lanes = TODO_STATUSES.map((s) => ({
    id: s.id,
    label: s.label,
    hint: s.hint,
    dot: TONE_DOT[s.tone],
    items: props.todos.filter((t) => statusOf(t) === s.id),
  }))
  return <LaneBoard lanes={lanes} props={props} onDrop={(id, lane) => props.onSetStatus(id, lane as TodoStatus)} />
}

/**
 * Due-date lanes — drag a card to reschedule it. Overdue is a consequence, not
 * a destination, so its lane takes no drops (dueForBucket returns undefined).
 */
export function TimeView(props: TodoViewProps) {
  const open = props.todos.filter((t) => !t.done)
  const lanes = DUE_BUCKETS.map((b) => ({
    id: b.id,
    label: b.label,
    hint: b.id === 'today' ? props.today.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : b.hint,
    dot: b.id === 'overdue' ? 'bg-red-500' : b.id === 'today' ? 'bg-primary' : 'bg-faint',
    items: open.filter((t) => bucketOf(t, props.today) === b.id),
    droppable: b.id !== 'overdue',
  }))
  return (
    <LaneBoard
      lanes={lanes}
      props={props}
      onDrop={(id, lane) => {
        const due = dueForBucket(lane as DueBucket, props.today)
        if (due !== undefined) props.onSetDue(id, due)
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Calendar — the month, plus the undated pile you drag onto a day.
// ---------------------------------------------------------------------------

/**
 * One scheduled to-do inside a calendar cell. Draggable in its own right, so a
 * date can be changed by moving the chip from one day to another (or back onto
 * the undated pile) — previously only the undated pile could start a drag, which
 * made the calendar a one-way trip.
 */
function DayChip({ todo, today, onOpen, remote }: { todo: Todo; today: Date; onOpen: () => void; remote: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: todo.id })
  const down = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY }
        listeners?.onPointerDown?.(e)
      }}
      onClick={(e) => {
        const from = down.current
        if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) return
        onOpen()
      }}
      title={todo.title}
      className={`cursor-grab truncate rounded border-l-2 bg-surface-2 px-1.5 py-0.5 text-left text-[11px] font-semibold text-text transition active:cursor-grabbing hover:bg-surface-hover ${
        isDragging ? 'opacity-40' : ''
      } ${remote ? 'ring-1 ring-info' : ''} ${
        daysUntilDue(todo.due_date!, today) < 0 ? 'border-red-500' : 'border-primary'
      }`}
    >
      {todo.title}
    </div>
  )
}

function DayCell({
  day,
  items,
  today,
  onOpen,
  remoteIds,
}: {
  day: Date
  items: Todo[]
  today: Date
  onOpen: (id: string) => void
  remoteIds: ReadonlySet<string>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${isoDate(day)}` })
  const isToday = day.toDateString() === today.toDateString()
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-[6rem] flex-col gap-1 border-b border-r border-border p-1.5 transition ${
        isOver ? 'bg-primary-soft' : isToday ? 'bg-primary-soft/40' : 'bg-surface'
      }`}
    >
      <span className={`text-xs ${isToday ? 'font-extrabold text-primary' : 'font-semibold text-faint'}`}>{day.getDate()}</span>
      {items.slice(0, 3).map((t) => (
        <DayChip key={t.id} todo={t} today={today} onOpen={() => onOpen(t.id)} remote={remoteIds.has(t.id)} />
      ))}
      {items.length > 3 && <span className="text-[10px] font-semibold text-faint">+{items.length - 3} more</span>}
    </div>
  )
}

export function CalendarView(props: TodoViewProps) {
  const [monthOffset, setMonthOffset] = useState(0)
  const month = useMemo(
    () => new Date(props.today.getFullYear(), props.today.getMonth() + monthOffset, 1),
    [props.today, monthOffset],
  )
  const cells = useMemo(() => monthGrid(month), [month])
  const open = props.todos.filter((t) => !t.done)
  const undated = open.filter((t) => !t.due_date)
  // Pointer drag needs a 4px threshold so a plain click stays a click. The
  // keyboard sensor is not optional decoration: dnd-kit's `attributes` put
  // role="button" and tabIndex on every card, which promises a keyboard user
  // they can move it — registering the sensor is what makes that true.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )
  const [dragging, setDragging] = useState<string | null>(null)
  const active = dragging ? props.todos.find((t) => t.id === dragging) : null

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))}
      onDragCancel={() => setDragging(null)}
      onDragEnd={(e) => {
        setDragging(null)
        const over = String(e.over?.id ?? '')
        if (over.startsWith('day:')) props.onSetDue(String(e.active.id), over.slice(4))
        else if (over === 'undated') props.onSetDue(String(e.active.id), null)
      }}
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <button
              onClick={() => setMonthOffset((v) => v - 1)}
              className="rounded-md px-2 py-1 text-sm font-semibold text-muted hover:bg-surface-hover"
            >
              ←
            </button>
            <span className="flex-1 text-center text-sm font-bold text-text">
              {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </span>
            <button
              onClick={() => setMonthOffset((v) => v + 1)}
              className="rounded-md px-2 py-1 text-sm font-semibold text-muted hover:bg-surface-hover"
            >
              →
            </button>
          </div>
          <div className="grid grid-cols-7 border-b border-border">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide text-faint">
                {d}
              </div>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-7 overflow-y-auto">
            {cells.map((c, i) =>
              c ? (
                <DayCell
                  key={i}
                  day={c}
                  today={props.today}
                  onOpen={props.onOpen}
                  remoteIds={props.remoteIds}
                  items={open.filter((t) => sameLocalDate(t.due_date, c))}
                />
              ) : (
                <div key={i} className="min-h-[6rem] border-b border-r border-border bg-surface-2" />
              ),
            )}
          </div>
        </div>

        <UndatedPile items={undated} props={props} />
      </div>
      <DragOverlay dropAnimation={null}>
        {active ? (
          <TodoCard
            todo={active}
            collections={props.collectionsOf(active.id)}
            onOpen={() => {}}
            today={props.today}
            overlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function UndatedPile({ items, props }: { items: Todo[]; props: TodoViewProps }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'undated' })
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-0 flex-col rounded-2xl border transition ${
        isOver ? 'border-primary-soft-border bg-primary-soft' : 'border-border bg-surface-2'
      }`}
    >
      <header className="px-3 pb-1 pt-3">
        <h3 className="text-[13px] font-bold text-text">No date ({items.length})</h3>
        <p className="mt-0.5 text-[11px] text-faint">Drag one onto a day to schedule it.</p>
      </header>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
        {items.map((t) => (
          <TodoCard
            key={t.id}
            todo={t}
            collections={props.collectionsOf(t.id)}
            onOpen={() => props.onOpen(t.id)}
            onToggleDone={() => props.onToggleDone(t.id)}
            remote={props.remoteIds.has(t.id)}
            today={props.today}
          />
        ))}
        {items.length === 0 && <p className="py-4 text-center text-xs text-faint">Everything is scheduled.</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Focus — one to-do at a time, hardest-to-ignore first.
// ---------------------------------------------------------------------------

export function FocusView(props: TodoViewProps) {
  const queue = useMemo(() => focusQueue(props.todos, props.today), [props.todos, props.today])
  // Anything you've already handled or skipped moves to the BACK rather than
  // advancing an index: the queue re-sorts on every edit (completing a to-do
  // removes it, rescheduling one re-ranks it), so a positional cursor would
  // jump around. "Start it" in particular leaves the to-do in the queue, and
  // without this it would stay stubbornly on screen.
  const [seen, setSeen] = useState<string[]>([])
  const ordered = useMemo(() => {
    const back = new Set(seen)
    return [...queue.filter((t) => !back.has(t.id)), ...queue.filter((t) => back.has(t.id))]
  }, [queue, seen])
  const item = ordered[0]

  // The bar measures the session, not the queue: `ordered` is a reordering of
  // `queue`, so comparing the two would always read zero. Remember the high-
  // water mark instead and count down from it.
  const [total, setTotal] = useState(queue.length)
  useEffect(() => setTotal((t) => Math.max(t, queue.length)), [queue.length])

  if (!item) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">Nothing open — the queue is clear.</p>
      </div>
    )
  }

  const advance = () => setSeen((s) => [...s.filter((id) => id !== item.id), item.id])
  const act = (fn: () => void) => {
    fn()
    advance()
  }
  const collections = props.collectionsOf(item.id)

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6">
      <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-widest text-faint">
        <span>{ordered.length} left</span>
        <span className="h-1 w-40 overflow-hidden rounded-full bg-surface-2">
          <span
            className="block h-full bg-primary transition-all"
            style={{ width: `${total ? ((total - queue.length) / total) * 100 : 0}%` }}
          />
        </span>
      </div>

      <article className="flex w-full max-w-2xl flex-col gap-4 rounded-2xl border border-border bg-surface p-7 shadow-soft-lg">
        <div className="flex flex-wrap items-center gap-2">
          {collections.map((name) => (
            <MiniToken key={name} name={name} />
          ))}
          <DueChip due={item.due_date} done={false} today={props.today} />
          <SourceTag source={item.source} />
        </div>
        <h2 className="text-2xl font-extrabold leading-tight tracking-tight text-text">{item.title}</h2>
        {item.notes && <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-muted">{item.notes}</p>}
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <button
            onClick={() => act(() => props.onSetStatus(item.id, 'done'))}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <CheckIcon className="h-4 w-4" /> Done
          </button>
          <button
            onClick={() => act(() => props.onSetStatus(item.id, 'doing'))}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            <PlayIcon className="h-4 w-4" /> Start it
          </button>
          <button
            onClick={() => act(() => props.onSetDue(item.id, isoDateOffset(1, props.today)))}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            <CalendarIcon className="h-4 w-4" /> Tomorrow
          </button>
          <button
            onClick={() => act(() => props.onSetDue(item.id, isoDateOffset(7, props.today)))}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            <CalendarIcon className="h-4 w-4" /> Next week
          </button>
          <button
            onClick={advance}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-faint hover:text-text"
          >
            Skip <ArrowRightIcon className="h-4 w-4" />
          </button>
        </div>
      </article>

      <p className="text-xs text-faint">Overdue first, then due today, then whatever is blocked or an agent filed for you.</p>
    </div>
  )
}
