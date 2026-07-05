import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Database, UserTableColumn, UserTableColumnType } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { streamChat } from '../lib/chat'
import {
  ArrowRightIcon,
  CalendarIcon,
  GlobeIcon,
  LockIcon,
  PlusIcon,
  SearchIcon,
  SparkleIcon,
  TableIcon,
  TrashIcon,
} from '../components/icons'

type UserTable = Database['public']['Tables']['user_tables']['Row']
type Row = Record<string, unknown>

// User tables are created at runtime, so they aren't in the generated types.
// Query them through an untyped view of the same authenticated client (RLS
// still applies — the user only ever sees rows they're allowed to).
const dyn = (name: string) => (supabase as unknown as { from: (t: string) => any }).from(name)

// Turn a human label into a safe physical column key (must match the RPC's
// `^[a-z][a-z0-9_]*$` rule), matching how the chat/MCP callers build keys.
function slugifyKey(label: string): string {
  const s = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!s) return 'col'
  return /^[a-z]/.test(s) ? s : `c_${s}`
}

// A just-created table can take a moment to appear in PostgREST's schema cache.
// Retry the query while we see the "schema cache / table not found" error.
async function schemaRetry<T>(
  run: () => Promise<{ data: T; error: { message: string } | null }>,
): Promise<{ data: T; error: { message: string } | null }> {
  let res = await run()
  for (let attempt = 0; attempt < 6 && res.error; attempt++) {
    if (!/schema cache|find the table|PGRST205/i.test(res.error.message)) break
    await new Promise((r) => setTimeout(r, 600 + attempt * 400))
    res = await run()
  }
  return res
}

const COLUMN_TYPES: { value: UserTableColumnType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'longtext', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Whole number' },
  { value: 'boolean', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' },
  { value: 'json', label: 'JSON' },
]

function typeLabel(t: UserTableColumnType): string {
  return COLUMN_TYPES.find((c) => c.value === t)?.label ?? t
}

// Little Airtable-style field glyphs so column headers read as "what kind of
// thing goes here" instead of database jargon.
function TypeGlyph({ type }: { type: UserTableColumnType }) {
  if (type === 'date' || type === 'datetime')
    return <CalendarIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
  const glyph =
    type === 'longtext' ? '≡' : type === 'number' || type === 'integer' ? '#' : type === 'boolean' ? '✓' : type === 'json' ? '{}' : 'A'
  return (
    <span className="w-3.5 shrink-0 text-center font-mono text-[11px] font-semibold leading-none opacity-70">
      {glyph}
    </span>
  )
}

// Each table gets a stable accent color (hashed from its id) — the same trick
// Airtable uses to make bases feel like "things" instead of schemas.
const ACCENTS = [
  'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'bg-amber-500/20 text-amber-600 dark:text-amber-400',
  'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
  'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400',
]

function accentOf(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ACCENTS[Math.abs(h) % ACCENTS.length]
}

function columnsOf(t: UserTable): UserTableColumn[] {
  return (Array.isArray(t.columns) ? t.columns : []) as unknown as UserTableColumn[]
}

export default function TablesPage() {
  const { user } = useAuth()
  const [tables, setTables] = useState<UserTable[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('user_tables')
      .select('*')
      .order('updated_at', { ascending: false })
    setTables(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selected = useMemo(() => tables.find((t) => t.id === selectedId) ?? null, [tables, selectedId])

  return (
    <div className="flex h-full min-h-0">
      {/* Collapsed rail (desktop only): give the grid the full width. */}
      <div
        className={`hidden w-11 shrink-0 flex-col items-center gap-2 border-r border-border bg-surface py-3 ${
          collapsed ? 'md:flex' : 'md:hidden'
        }`}
      >
        <button
          onClick={() => setCollapsed(false)}
          title="Show tables"
          aria-label="Show tables"
          className="rounded-lg p-2 text-muted hover:bg-surface-hover hover:text-text"
        >
          <ArrowRightIcon className="h-5 w-5" />
        </button>
        <button
          onClick={() => setShowNew(true)}
          title="New table"
          aria-label="New table"
          className="rounded-lg bg-primary p-2 text-white hover:bg-primary-strong"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>

      {/* List pane */}
      <div
        className={`w-full shrink-0 flex-col border-r border-border bg-surface ${
          selected ? 'hidden' : 'flex'
        } ${collapsed ? 'md:hidden' : 'md:flex md:w-80'}`}
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <h1 className="flex-1 text-lg font-semibold tracking-tight text-text">Tables</h1>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> New
          </button>
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse list"
            aria-label="Collapse list"
            className="hidden rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-text md:block"
          >
            <ArrowRightIcon className="h-5 w-5 rotate-180" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <p className="px-2 text-sm text-faint">Loading…</p>
          ) : tables.length === 0 ? (
            <div className="px-2 py-6 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary">
                <TableIcon className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-text">Track anything here</p>
              <p className="mt-1 text-xs text-muted">
                Leads, job applications, an inventory, a reading list — describe it and AI sets up
                the columns, or build them yourself. No database skills needed.
              </p>
              <button
                onClick={() => setShowNew(true)}
                className="mx-auto mt-4 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong"
              >
                <PlusIcon className="h-4 w-4" /> Create your first table
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              {tables.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                    t.id === selectedId ? 'bg-primary-soft' : 'hover:bg-surface-hover'
                  }`}
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${accentOf(t.id)}`}
                  >
                    <TableIcon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm font-medium ${
                        t.id === selectedId ? 'text-primary' : 'text-text'
                      }`}
                    >
                      {t.name}
                    </span>
                    <span className="flex items-center gap-1 text-[11px] text-faint">
                      {t.visibility === 'workspace' ? (
                        <>
                          <GlobeIcon className="h-3 w-3" /> Shared with everyone
                        </>
                      ) : (
                        <>
                          <LockIcon className="h-3 w-3" /> Just you
                        </>
                      )}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div className={`min-w-0 flex-1 ${selected ? 'flex' : 'hidden md:flex'} flex-col bg-bg`}>
        {selected ? (
          <TableGrid
            key={selected.id}
            table={selected}
            userId={user?.id ?? ''}
            onBack={() => setSelectedId(null)}
            onChanged={load}
            onDeleted={() => {
              setSelectedId(null)
              load()
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-md text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft text-primary">
                <TableIcon className="h-7 w-7" />
              </div>
              <h2 className="text-lg font-semibold text-text">Your tables</h2>
              <p className="mt-2 text-sm text-muted">
                Pick a table on the left to see what's inside — click any cell to edit it, just
                like a spreadsheet.
              </p>
              <p className="mt-2 text-sm text-muted">
                Or start a new one: describe what you want to track and AI sets up the columns for
                you. The assistant in Chat can read and update your tables too.
              </p>
              <button
                onClick={() => setShowNew(true)}
                className="mx-auto mt-5 flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
              >
                <PlusIcon className="h-4 w-4" /> New table
              </button>
            </div>
          </div>
        )}
      </div>

      {showNew && (
        <NewTableModal
          ownerId={user?.id ?? ''}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false)
            setSelectedId(id)
            load()
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Grid: view + edit rows of a single user table
// ---------------------------------------------------------------------------
function TableGrid({
  table,
  userId,
  onBack,
  onChanged,
  onDeleted,
}: {
  table: UserTable
  userId: string
  onBack: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const cols = columnsOf(table)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showAddField, setShowAddField] = useState(false)
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const loadRows = useCallback(async () => {
    setLoading(true)
    const { data, error } = await schemaRetry(() =>
      dyn(table.physical_name).select('*').order('created_at', { ascending: true }).limit(500),
    )
    setErr(error ? error.message : null)
    setRows((data as Row[]) ?? [])
    setLoading(false)
  }, [table.physical_name])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      cols.some((c) => {
        const v = r[c.key]
        return v !== null && v !== undefined && String(typeof v === 'object' ? JSON.stringify(v) : v).toLowerCase().includes(q)
      }),
    )
  }, [rows, cols, query])

  async function addRow() {
    setBusy(true)
    setErr(null)
    const { error } = await schemaRetry(() => dyn(table.physical_name).insert({ owner_id: userId }))
    setBusy(false)
    if (error) {
      setErr(error.message)
      return
    }
    loadRows()
  }

  async function deleteRow(id: string) {
    const { error } = await dyn(table.physical_name).delete().eq('id', id)
    if (error) {
      setErr(error.message)
      return
    }
    setRows((rs) => rs.filter((r) => r.id !== id))
    setExpandedRowId((cur) => (cur === id ? null : cur))
  }

  async function commitCell(id: string, key: string, value: unknown) {
    setErr(null)
    const { error } = await dyn(table.physical_name)
      .update({ [key]: value, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) {
      setErr(error.message)
      throw error
    }
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [key]: value } : r)))
  }

  const expandedRow = expandedRowId ? rows.find((r) => String(r.id) === expandedRowId) ?? null : null

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 md:px-5">
        <button
          onClick={onBack}
          className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-hover md:hidden"
        >
          ‹ Back
        </button>
        <span
          className={`hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:flex ${accentOf(table.id)}`}
        >
          <TableIcon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-text">{table.name}</h2>
          <p className="truncate text-xs text-faint">
            {table.visibility === 'workspace' ? 'Shared with everyone' : 'Just you'} ·{' '}
            {query.trim()
              ? `${visibleRows.length} of ${rows.length} row${rows.length === 1 ? '' : 's'}`
              : `${rows.length} row${rows.length === 1 ? '' : 's'}`}
          </p>
        </div>
        {rows.length > 0 && (
          <div className="relative hidden sm:block">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search rows…"
              className="w-40 rounded-lg border border-border bg-bg py-1.5 pl-8 pr-2 text-sm outline-none transition focus:w-56 focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </div>
        )}
        <button
          onClick={() => setShowSettings(true)}
          className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover"
        >
          Settings
        </button>
        <button
          onClick={addRow}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
        >
          <PlusIcon className="h-4 w-4" /> New row
        </button>
      </div>

      {err && <p className="border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-600">{err}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <p className="p-5 text-sm text-faint">Loading…</p>
        ) : cols.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-sm text-center">
              <p className="text-sm font-medium text-text">No fields yet</p>
              <p className="mt-1 text-sm text-muted">
                Add your first field — a field is just a column, like “Name” or “Due date”.
              </p>
              <button
                onClick={() => setShowAddField(true)}
                className="mx-auto mt-4 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong"
              >
                <PlusIcon className="h-4 w-4" /> Add a field
              </button>
            </div>
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr>
                <th className="w-12 border-b-2 border-border bg-surface px-2 py-2.5 text-center text-[11px] font-medium text-faint">
                  #
                </th>
                {cols.map((c) => (
                  <th
                    key={c.key}
                    title={typeLabel(c.type)}
                    className="border-b-2 border-r border-border px-3 py-2.5 text-left font-medium text-muted"
                  >
                    <span className="flex items-center gap-1.5">
                      <TypeGlyph type={c.type} />
                      <span className="truncate">{c.label}</span>
                    </span>
                  </th>
                ))}
                <th className="w-12 border-b-2 border-border p-0 text-center">
                  <button
                    onClick={() => setShowAddField(true)}
                    title="Add a field"
                    aria-label="Add a field"
                    className="flex h-full w-full items-center justify-center py-2.5 text-faint hover:bg-surface-hover hover:text-primary"
                  >
                    <PlusIcon className="h-4 w-4" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r, i) => (
                <tr key={String(r.id)} className="group hover:bg-surface-hover/60">
                  <td className="border-b border-border p-0 text-center align-middle">
                    <button
                      onClick={() => setExpandedRowId(String(r.id))}
                      title="Open this row"
                      className="flex h-full w-full items-center justify-center py-2 text-xs text-faint hover:text-primary"
                    >
                      <span className="group-hover:hidden">{i + 1}</span>
                      <span className="hidden font-semibold group-hover:inline">↗</span>
                    </button>
                  </td>
                  {cols.map((c) => (
                    <td key={c.key} className="border-b border-r border-border p-0 align-top">
                      <Cell
                        column={c}
                        value={r[c.key]}
                        onCommit={(v) => commitCell(String(r.id), c.key, v)}
                      />
                    </td>
                  ))}
                  <td className="border-b border-border text-center align-middle">
                    <button
                      onClick={() => deleteRow(String(r.id))}
                      className="rounded p-1 text-faint opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
                      title="Delete row"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={cols.length + 2} className="px-3 py-10 text-center">
                    <p className="text-sm font-medium text-text">Ready for your first row</p>
                    <p className="mx-auto mt-1 max-w-xs text-xs text-muted">
                      Click below to add one, then click any cell to type — it saves as you go. You
                      can also ask the assistant in Chat to fill this table for you.
                    </p>
                  </td>
                </tr>
              )}
              {rows.length > 0 && visibleRows.length === 0 && (
                <tr>
                  <td colSpan={cols.length + 2} className="px-3 py-8 text-center text-sm text-faint">
                    Nothing matches “{query}”.
                  </td>
                </tr>
              )}
              {!query.trim() && (
                <tr>
                  <td colSpan={cols.length + 2} className="p-0">
                    <button
                      onClick={addRow}
                      disabled={busy}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-faint hover:bg-primary-soft/40 hover:text-primary disabled:opacity-50"
                    >
                      <PlusIcon className="ml-1 h-4 w-4" /> New row
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {expandedRow && (
        <RecordModal
          table={table}
          row={expandedRow}
          onClose={() => setExpandedRowId(null)}
          onCommit={commitCell}
          onDelete={() => deleteRow(String(expandedRow.id))}
        />
      )}

      {showAddField && (
        <AddFieldModal
          table={table}
          onClose={() => setShowAddField(false)}
          onAdded={() => {
            setShowAddField(false)
            onChanged()
            loadRows()
          }}
        />
      )}

      {showSettings && (
        <TableSettingsModal
          table={table}
          onClose={() => setShowSettings(false)}
          onChanged={() => {
            onChanged()
            loadRows()
          }}
          onDeleted={onDeleted}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// One editable cell (typed input, commits on blur)
// ---------------------------------------------------------------------------
function Cell({
  column,
  value,
  onCommit,
  inForm = false,
}: {
  column: UserTableColumn
  value: unknown
  onCommit: (value: unknown) => Promise<void>
  inForm?: boolean
}) {
  const inputCls =
    'w-full border-0 bg-transparent px-3 py-2 text-sm text-text outline-none' +
    (inForm ? '' : ' focus:bg-primary-soft/40 focus:ring-2 focus:ring-inset focus:ring-primary/40')

  const [draft, setDraft] = useState(() => toInputValue(value, column.type))
  useEffect(() => {
    setDraft(toInputValue(value, column.type))
  }, [value, column.type])

  if (column.type === 'boolean') {
    return (
      <div className={`flex items-center px-3 py-2 ${inForm ? '' : 'justify-center'}`}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onCommit(e.target.checked)}
          className="h-4 w-4 accent-primary"
        />
      </div>
    )
  }

  async function commit() {
    let parsed: unknown
    try {
      parsed = fromInputValue(draft, column.type)
    } catch {
      // invalid JSON etc. — revert to last good value
      setDraft(toInputValue(value, column.type))
      return
    }
    if (parsed === value) return
    try {
      await onCommit(parsed)
    } catch {
      setDraft(toInputValue(value, column.type))
    }
  }

  if (column.type === 'longtext' || column.type === 'json') {
    return (
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={inForm ? 3 : 1}
        spellCheck={column.type !== 'json'}
        className={`${inputCls} resize-y ${column.type === 'json' ? 'font-mono text-xs' : ''}`}
      />
    )
  }

  const inputType =
    column.type === 'number' || column.type === 'integer'
      ? 'number'
      : column.type === 'date'
        ? 'date'
        : column.type === 'datetime'
          ? 'datetime-local'
          : 'text'

  return (
    <input
      type={inputType}
      value={draft}
      step={column.type === 'integer' ? 1 : column.type === 'number' ? 'any' : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      className={inputCls}
    />
  )
}

function toInputValue(value: unknown, type: UserTableColumnType): string {
  if (value === null || value === undefined) return ''
  if (type === 'datetime') {
    // ISO -> 'YYYY-MM-DDTHH:mm' for datetime-local
    const d = new Date(String(value))
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  if (type === 'date') return String(value).slice(0, 10)
  if (type === 'json') return JSON.stringify(value, null, 2)
  return String(value)
}

function fromInputValue(draft: string, type: UserTableColumnType): unknown {
  const s = draft.trim()
  if (s === '') return null
  switch (type) {
    case 'number':
      return Number(s)
    case 'integer':
      return parseInt(s, 10)
    case 'datetime':
      return new Date(draft).toISOString()
    case 'json':
      return JSON.parse(draft) // throws on bad JSON -> caller reverts
    default:
      return draft
  }
}

// ---------------------------------------------------------------------------
// Record view: one row opened as a friendly form (the Airtable "expand record")
// ---------------------------------------------------------------------------
function RecordModal({
  table,
  row,
  onClose,
  onCommit,
  onDelete,
}: {
  table: UserTable
  row: Row
  onClose: () => void
  onCommit: (id: string, key: string, value: unknown) => Promise<void>
  onDelete: () => void
}) {
  const cols = columnsOf(table)
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-3">
          <span className={`flex h-7 w-7 items-center justify-center rounded-md ${accentOf(table.id)}`}>
            <TableIcon className="h-3.5 w-3.5" />
          </span>
          <h2 className="flex-1 truncate text-sm font-semibold text-text">{table.name} — row</h2>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            Done
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {cols.map((c) => (
            <label key={c.key} className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
                <TypeGlyph type={c.type} /> {c.label}
              </span>
              <div className="rounded-lg border border-border-strong transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary-soft">
                <Cell
                  column={c}
                  value={row[c.key]}
                  onCommit={(v) => onCommit(String(row.id), c.key, v)}
                  inForm
                />
              </div>
            </label>
          ))}
          <p className="text-xs text-faint">Changes save automatically as you move between fields.</p>
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <button
            onClick={onDelete}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
          >
            <TrashIcon className="h-4 w-4" /> Delete row
          </button>
          <button
            onClick={onClose}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add a field without leaving the grid
// ---------------------------------------------------------------------------
function AddFieldModal({
  table,
  onClose,
  onAdded,
}: {
  table: UserTable
  onClose: () => void
  onAdded: () => void
}) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState<UserTableColumnType>('text')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    if (!label.trim()) return
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.rpc('add_user_column', {
      p_table_id: table.id,
      p_key: slugifyKey(label),
      p_type: type,
      p_label: label.trim(),
    })
    setBusy(false)
    if (e) {
      setError(e.message)
      return
    }
    onAdded()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">Add a field</h2>
        </div>
        <div className="space-y-3 p-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">What do you want to call it?</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="e.g. Due date, Status, Notes"
              autoFocus
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">What kind of thing goes in it?</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as UserTableColumnType)}
              className="w-full rounded-lg border border-border-strong px-2 py-2 text-sm"
            >
              {COLUMN_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={add}
            disabled={busy || !label.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add field'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// New table modal (AI-first + manual builder)
// ---------------------------------------------------------------------------
interface DraftColumn {
  label: string
  type: UserTableColumnType
}

const TEMPLATE_PROMPTS: { label: string; prompt: string }[] = [
  { label: 'Simple CRM', prompt: 'a CRM to track leads: company, contact, stage, deal value, next step, last touched' },
  { label: 'Content calendar', prompt: 'a content calendar: title, channel, status, publish date, owner, notes' },
  { label: 'Job applications', prompt: 'a job application tracker: company, role, status, applied date, salary range, notes' },
  { label: 'Inventory', prompt: 'a simple inventory: item, SKU, quantity on hand, reorder point, supplier, last counted' },
]

function NewTableModal({
  ownerId,
  onClose,
  onCreated,
}: {
  ownerId: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'workspace'>('private')
  const [columns, setColumns] = useState<DraftColumn[]>([{ label: 'Name', type: 'text' }])
  const [aiPrompt, setAiPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function setCol(i: number, patch: Partial<DraftColumn>) {
    setColumns((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  async function generate(promptText?: string) {
    const prompt = (promptText ?? aiPrompt).trim()
    if (!prompt) return
    setGenerating(true)
    setError(null)
    try {
      const text = await streamChat(
        [{ role: 'user', content: prompt }],
        () => {},
        {
          replaceSystem: true,
          system:
            'You design database tables. Given a description, output ONLY minified JSON in this exact shape: ' +
            '{"name": string, "columns": [{"label": string, "type": one of "text"|"longtext"|"number"|"integer"|"boolean"|"date"|"datetime"|"json"}]}. ' +
            'Pick 3-8 sensible columns. Do NOT include an id/created/updated column. No prose, no code fences.',
        },
      )
      const json = JSON.parse(text.replace(/```json|```/g, '').trim())
      if (json.name && !name.trim()) setName(String(json.name))
      if (Array.isArray(json.columns) && json.columns.length) {
        setColumns(
          json.columns.map((c: { label?: string; type?: string }) => ({
            label: String(c.label ?? 'Field'),
            type: (COLUMN_TYPES.find((t) => t.value === c.type)?.value ?? 'text') as UserTableColumnType,
          })),
        )
      }
    } catch {
      setError("AI couldn't produce a valid setup. Try rephrasing, or build it by hand below.")
    }
    setGenerating(false)
  }

  async function create() {
    if (!name.trim()) {
      setError('Give the table a name.')
      return
    }
    const cleaned = columns.filter((c) => c.label.trim())
    if (cleaned.length === 0) {
      setError('Add at least one field.')
      return
    }
    setSaving(true)
    setError(null)
    const { data, error: rpcErr } = await supabase.rpc('create_user_table', {
      p_name: name.trim(),
      p_columns: cleaned.map((c) => ({ key: slugifyKey(c.label), label: c.label.trim(), type: c.type })),
      p_visibility: visibility,
      p_owner: ownerId,
    })
    setSaving(false)
    if (rpcErr) {
      setError(rpcErr.message)
      return
    }
    const created = (Array.isArray(data) ? data[0] : data) as { id: string } | null
    if (created?.id) onCreated(created.id)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">Create a table</h2>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* AI generate */}
          <div className="rounded-xl border border-primary-soft-border bg-primary-soft/40 p-3.5">
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-primary">
              <SparkleIcon className="h-3.5 w-3.5" /> Describe what you want to track
            </label>
            <div className="flex gap-2">
              <input
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && generate()}
                placeholder="e.g. my plants and when I last watered them"
                className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
              <button
                onClick={() => generate()}
                disabled={generating || !aiPrompt.trim()}
                className="shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
              >
                {generating ? 'Thinking…' : 'Set it up'}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TEMPLATE_PROMPTS.map((t) => (
                <button
                  key={t.label}
                  onClick={() => {
                    setAiPrompt(t.prompt)
                    generate(t.prompt)
                  }}
                  disabled={generating}
                  className="rounded-full border border-primary-soft-border bg-surface px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary-soft disabled:opacity-50"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Table name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Leads"
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>

          <div>
            <span className="mb-1 block text-xs font-medium text-muted">
              Fields <span className="font-normal text-faint">(the columns of your table)</span>
            </span>
            <div className="space-y-2">
              {columns.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={c.label}
                    onChange={(e) => setCol(i, { label: e.target.value })}
                    placeholder="Field name"
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                  <select
                    value={c.type}
                    onChange={(e) => setCol(i, { type: e.target.value as UserTableColumnType })}
                    className="w-36 shrink-0 rounded-lg border border-border-strong px-2 py-2 text-sm"
                  >
                    {COLUMN_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => setColumns((cs) => cs.filter((_, idx) => idx !== i))}
                    className="shrink-0 rounded-lg px-2 text-faint hover:bg-red-50 hover:text-red-600"
                    title="Remove field"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setColumns((cs) => [...cs, { label: '', type: 'text' }])}
              className="mt-2 flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <PlusIcon className="h-4 w-4" /> Add field
            </button>
          </div>

          <label className="flex items-center gap-2.5 rounded-xl border border-border p-3">
            <input
              type="checkbox"
              checked={visibility === 'workspace'}
              onChange={(e) => setVisibility(e.target.checked ? 'workspace' : 'private')}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm text-text">
              Share with the workspace
              <span className="block text-xs text-faint">
                Everyone can see it and add rows. Otherwise it's just for you.
              </span>
            </span>
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={saving || !name.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create table'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Table settings (rename / share / manage fields / delete)
// ---------------------------------------------------------------------------
function TableSettingsModal({
  table,
  onClose,
  onChanged,
  onDeleted,
}: {
  table: UserTable
  onClose: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const [name, setName] = useState(table.name)
  const [visibility, setVisibility] = useState(table.visibility)
  const [newColLabel, setNewColLabel] = useState('')
  const [newColType, setNewColType] = useState<UserTableColumnType>('text')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cols = columnsOf(table)

  async function saveMeta() {
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.rpc('update_user_table', {
      p_table_id: table.id,
      p_name: name.trim(),
      p_visibility: visibility,
    })
    setBusy(false)
    if (e) {
      setError(e.message)
      return
    }
    onChanged()
    onClose()
  }

  async function addColumn() {
    if (!newColLabel.trim()) return
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.rpc('add_user_column', {
      p_table_id: table.id,
      p_key: slugifyKey(newColLabel),
      p_type: newColType,
      p_label: newColLabel.trim(),
    })
    setBusy(false)
    if (e) {
      setError(e.message)
      return
    }
    setNewColLabel('')
    onChanged()
    onClose()
  }

  async function dropColumn(key: string) {
    if (!confirm(`Delete this field and everything typed in it?`)) return
    const { error: e } = await supabase.rpc('drop_user_column', { p_table_id: table.id, p_key: key })
    if (e) {
      setError(e.message)
      return
    }
    onChanged()
    onClose()
  }

  async function dropTable() {
    if (!confirm(`Delete the whole table “${table.name}” and all its rows? This cannot be undone.`))
      return
    const { error: e } = await supabase.rpc('drop_user_table', { p_table_id: table.id })
    if (e) {
      setError(e.message)
      return
    }
    onDeleted()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text">Table settings</h2>
          <button
            onClick={dropTable}
            className="rounded-md p-1.5 text-faint hover:bg-red-50 hover:text-red-600"
            title="Delete table"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
            />
          </label>

          <label className="flex items-center gap-2.5 rounded-xl border border-border p-3">
            <input
              type="checkbox"
              checked={visibility === 'workspace'}
              onChange={(e) => setVisibility(e.target.checked ? 'workspace' : 'private')}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm text-text">
              Share with the workspace
              <span className="block text-xs text-faint">Everyone can see it and add rows.</span>
            </span>
          </label>

          <div>
            <span className="mb-1 block text-xs font-medium text-muted">Fields</span>
            <div className="space-y-1.5">
              {cols.map((c) => (
                <div
                  key={c.key}
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2"
                >
                  <TypeGlyph type={c.type} />
                  <span className="flex-1 text-sm text-text">{c.label}</span>
                  <span className="text-[11px] text-faint">{typeLabel(c.type)}</span>
                  <button
                    onClick={() => dropColumn(c.key)}
                    className="rounded p-1 text-faint hover:bg-red-50 hover:text-red-600"
                    title="Delete field"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={newColLabel}
                onChange={(e) => setNewColLabel(e.target.value)}
                placeholder="New field"
                className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
              <select
                value={newColType}
                onChange={(e) => setNewColType(e.target.value as UserTableColumnType)}
                className="w-36 shrink-0 rounded-lg border border-border-strong px-2 py-2 text-sm"
              >
                {COLUMN_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                onClick={addColumn}
                disabled={busy || !newColLabel.trim()}
                className="shrink-0 rounded-lg border border-border-strong px-3 text-sm font-medium text-muted hover:bg-surface-hover disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={saveMeta}
            disabled={busy || !name.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
