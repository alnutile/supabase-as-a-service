import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Database, UserTableColumn, UserTableColumnType } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { streamChat } from '../lib/chat'
import {
  GlobeIcon,
  LockIcon,
  PlusIcon,
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

const COLUMN_TYPES: { value: UserTableColumnType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'longtext', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'boolean', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' },
  { value: 'json', label: 'JSON' },
]

function columnsOf(t: UserTable): UserTableColumn[] {
  return (Array.isArray(t.columns) ? t.columns : []) as unknown as UserTableColumn[]
}

export default function TablesPage() {
  const { user } = useAuth()
  const [tables, setTables] = useState<UserTable[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

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
      {/* List pane */}
      <div
        className={`w-full shrink-0 flex-col border-r border-border bg-surface md:flex md:w-80 ${
          selected ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h1 className="text-lg font-semibold tracking-tight text-text">Tables</h1>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <p className="px-2 text-sm text-faint">Loading…</p>
          ) : tables.length === 0 ? (
            <div className="px-2 py-6 text-center">
              <TableIcon className="mx-auto mb-2 h-8 w-8 text-faint" />
              <p className="text-sm text-muted">No tables yet.</p>
              <p className="mt-1 text-xs text-faint">
                Create one by hand or describe it to AI — then enter data, or ask the assistant in
                Chat to add and read rows.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {tables.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition ${
                    t.id === selectedId
                      ? 'bg-primary-soft text-primary'
                      : 'text-muted hover:bg-surface-hover hover:text-text'
                  }`}
                >
                  <TableIcon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
                  {t.visibility === 'workspace' ? (
                    <GlobeIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  ) : (
                    <LockIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  )}
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
          <div className="flex h-full items-center justify-center text-sm text-faint">
            Select a table to view and edit its data.
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

  const loadRows = useCallback(async () => {
    setLoading(true)
    const { data, error } = await dyn(table.physical_name)
      .select('*')
      .order('created_at', { ascending: true })
      .limit(500)
    if (error) setErr(error.message)
    setRows((data as Row[]) ?? [])
    setLoading(false)
  }, [table.physical_name])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  async function addRow() {
    setBusy(true)
    setErr(null)
    const { error } = await dyn(table.physical_name).insert({ owner_id: userId })
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

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border bg-surface px-5 py-3">
        <button
          onClick={onBack}
          className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-hover md:hidden"
        >
          ‹ Back
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-text">{table.name}</h2>
          <p className="truncate text-xs text-faint">
            {table.visibility === 'workspace' ? 'Shared with the workspace' : 'Private to you'} ·{' '}
            {rows.length} row{rows.length === 1 ? '' : 's'}
          </p>
        </div>
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
          <PlusIcon className="h-4 w-4" /> Row
        </button>
      </div>

      {err && <p className="border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-600">{err}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <p className="p-5 text-sm text-faint">Loading…</p>
        ) : cols.length === 0 ? (
          <p className="p-5 text-sm text-faint">
            This table has no columns yet. Add one from Settings.
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                {cols.map((c) => (
                  <th
                    key={c.key}
                    className="border-b border-r border-border px-3 py-2 text-left font-semibold text-muted"
                  >
                    {c.label}
                    <span className="ml-1 text-[10px] font-normal uppercase text-faint">{c.type}</span>
                  </th>
                ))}
                <th className="w-10 border-b border-border" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)} className="hover:bg-surface-hover">
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
                      className="rounded p-1 text-faint hover:bg-red-50 hover:text-red-600"
                      title="Delete row"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={cols.length + 1} className="px-3 py-6 text-center text-sm text-faint">
                    No rows yet. Click “Row” to add one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

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
}: {
  column: UserTableColumn
  value: unknown
  onCommit: (value: unknown) => Promise<void>
}) {
  const inputCls =
    'w-full border-0 bg-transparent px-3 py-2 text-sm text-text outline-none focus:bg-primary-soft/40'

  const [draft, setDraft] = useState(() => toInputValue(value, column.type))
  useEffect(() => {
    setDraft(toInputValue(value, column.type))
  }, [value, column.type])

  if (column.type === 'boolean') {
    return (
      <div className="flex items-center justify-center px-3 py-2">
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
        rows={1}
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
// New table modal (manual builder + AI generate)
// ---------------------------------------------------------------------------
interface DraftColumn {
  label: string
  type: UserTableColumnType
}

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

  async function generate() {
    if (!aiPrompt.trim()) return
    setGenerating(true)
    setError(null)
    try {
      const text = await streamChat(
        [{ role: 'user', content: aiPrompt }],
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
      setError("AI couldn't produce a valid schema. Try rephrasing, or build it by hand.")
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
      setError('Add at least one column.')
      return
    }
    setSaving(true)
    setError(null)
    const { data, error: rpcErr } = await supabase.rpc('create_user_table', {
      p_name: name.trim(),
      p_columns: cleaned.map((c) => ({ label: c.label.trim(), type: c.type })),
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
          <h2 className="text-sm font-semibold text-text">New table</h2>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* AI generate */}
          <div className="rounded-xl border border-border bg-surface-2 p-3">
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
              <SparkleIcon className="h-3.5 w-3.5 text-primary" /> Describe it and let AI build the columns
            </label>
            <div className="flex gap-2">
              <input
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && generate()}
                placeholder="e.g. a CRM to track leads: company, contact, stage, value, next step"
                className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
              <button
                onClick={generate}
                disabled={generating || !aiPrompt.trim()}
                className="shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
              >
                {generating ? '…' : 'Generate'}
              </button>
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
            <span className="mb-1 block text-xs font-medium text-muted">Columns</span>
            <div className="space-y-2">
              {columns.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={c.label}
                    onChange={(e) => setCol(i, { label: e.target.value })}
                    placeholder="Column name"
                    className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  />
                  <select
                    value={c.type}
                    onChange={(e) => setCol(i, { type: e.target.value as UserTableColumnType })}
                    className="w-32 shrink-0 rounded-lg border border-border-strong px-2 py-2 text-sm"
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
                    title="Remove column"
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
              <PlusIcon className="h-4 w-4" /> Add column
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
                Everyone can read and add rows. Otherwise it's private to you.
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
// Table settings (rename / share / add+drop columns / delete)
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
      p_key: newColLabel
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'col',
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
    if (!confirm(`Delete column “${key}” and its data?`)) return
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
              <span className="block text-xs text-faint">Everyone can read and add rows.</span>
            </span>
          </label>

          <div>
            <span className="mb-1 block text-xs font-medium text-muted">Columns</span>
            <div className="space-y-1.5">
              {cols.map((c) => (
                <div
                  key={c.key}
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2"
                >
                  <span className="flex-1 text-sm text-text">{c.label}</span>
                  <span className="text-[10px] uppercase text-faint">{c.type}</span>
                  <button
                    onClick={() => dropColumn(c.key)}
                    className="rounded p-1 text-faint hover:bg-red-50 hover:text-red-600"
                    title="Drop column"
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
                placeholder="New column"
                className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
              <select
                value={newColType}
                onChange={(e) => setNewColType(e.target.value as UserTableColumnType)}
                className="w-32 shrink-0 rounded-lg border border-border-strong px-2 py-2 text-sm"
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
