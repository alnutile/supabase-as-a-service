import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatBytes, formatDate } from '../lib/util'
import { estimateTokensFromChars } from '../lib/tokens'
import { useOrchestratorContext } from '../lib/useModelContext'
import { ContextMeter } from '../components/ContextMeter'
import {
  ArrowRightIcon,
  ArtifactIcon,
  ChatIcon,
  CloseIcon,
  CollectionIcon,
  FileIcon,
  GlobeIcon,
  LockIcon,
  PlusIcon,
  TodoIcon,
  TrashIcon,
} from '../components/icons'

type Collection = Database['public']['Tables']['collections']['Row']

// One collection's contents, loaded on demand for the detail pane.
type Items = {
  artifacts: Array<{ id: string; title: string; type: string; updated_at: string }>
  files: Array<{ id: string; name: string; size_bytes: number | null }>
  todos: Array<{ id: string; title: string; done: boolean; due_date: string | null }>
}

export default function CollectionsPage() {
  const { user } = useAuth()
  const model = useOrchestratorContext()

  const [collections, setCollections] = useState<Collection[]>([])
  const [counts, setCounts] = useState<Record<string, { artifacts: number; files: number; todos: number }>>({})
  const [tokens, setTokens] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    const [cRes, caRes, cfRes, ctRes, stats] = await Promise.all([
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('collection_artifacts').select('collection_id'),
      supabase.from('collection_files').select('collection_id'),
      supabase.from('collection_todos').select('collection_id'),
      supabase.rpc('collection_token_stats'),
    ])
    setCollections(cRes.data ?? [])
    const c: Record<string, { artifacts: number; files: number; todos: number }> = {}
    const bump = (id: string, k: 'artifacts' | 'files' | 'todos') => {
      const row = (c[id] ??= { artifacts: 0, files: 0, todos: 0 })
      row[k] += 1
    }
    for (const r of caRes.data ?? []) bump(r.collection_id, 'artifacts')
    for (const r of cfRes.data ?? []) bump(r.collection_id, 'files')
    for (const r of ctRes.data ?? []) bump(r.collection_id, 'todos')
    setCounts(c)
    const tok: Record<string, number> = {}
    for (const s of stats.data ?? []) tok[s.collection_id] = estimateTokensFromChars(Number(s.char_total))
    setTokens(tok)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selected = useMemo(() => collections.find((c) => c.id === selectedId) ?? null, [collections, selectedId])

  async function createCollection() {
    if (creating) return
    setCreating(true)
    try {
      const { data } = await supabase
        .from('collections')
        .insert({ owner_id: user!.id, name: 'Untitled collection', visibility: 'private' })
        .select()
        .single()
      if (data) {
        setCollections((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
        setSelectedId(data.id)
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* List pane */}
      <div
        className={`w-full shrink-0 flex-col border-r border-border bg-surface ${
          selected ? 'hidden md:flex md:w-80' : 'flex md:w-80'
        }`}
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <h1 className="flex-1 text-lg font-semibold tracking-tight text-text">Collections</h1>
          <button
            onClick={createCollection}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <p className="px-2 text-sm text-faint">Loading…</p>
          ) : collections.length === 0 ? (
            <div className="px-2 py-6 text-center">
              <CollectionIcon className="mx-auto mb-2 h-8 w-8 text-faint" />
              <p className="text-sm text-muted">No collections yet.</p>
              <p className="mt-1 text-xs text-faint">
                Group artifacts, files and to-dos into a collection, then chat with the whole set at once.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {collections.map((c) => {
                const n = counts[c.id] ?? { artifacts: 0, files: 0, todos: 0 }
                const total = n.artifacts + n.files + n.todos
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition ${
                      c.id === selectedId ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-hover hover:text-text'
                    }`}
                  >
                    <CollectionIcon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.name}</span>
                      <span className="block truncate text-[11px] text-faint">
                        {total} item{total === 1 ? '' : 's'}
                        {tokens[c.id] ? ` · ≈${Math.round(tokens[c.id] / 100) / 10}k tok` : ''}
                      </span>
                    </span>
                    {c.visibility === 'workspace' ? (
                      <GlobeIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    ) : (
                      <LockIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div className={`min-w-0 flex-1 ${selected ? 'flex' : 'hidden md:flex'} flex-col bg-bg`}>
        {selected ? (
          <CollectionDetail
            key={selected.id}
            collection={selected}
            isOwner={selected.owner_id === user?.id}
            tokens={tokens[selected.id] ?? 0}
            model={model}
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
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">
                <CollectionIcon className="h-7 w-7" />
              </div>
              <h2 className="text-lg font-semibold text-text">Your collections</h2>
              <p className="mt-2 text-sm text-muted">
                A collection groups artifacts, files and to-dos so you can chat with a focused set at once.
                Pick one to see what's inside, or add items from the Artifacts, Files and To-dos pages.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail: a collection's contents, grouped by type
// ---------------------------------------------------------------------------
function CollectionDetail({
  collection,
  isOwner,
  tokens,
  model,
  onBack,
  onChanged,
  onDeleted,
}: {
  collection: Collection
  isOwner: boolean
  tokens: number
  model: ReturnType<typeof useOrchestratorContext>
  onBack: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const navigate = useNavigate()
  const [items, setItems] = useState<Items | null>(null)
  const [editing, setEditing] = useState(false)

  const loadItems = useCallback(async () => {
    const [a, f, t] = await Promise.all([
      supabase.from('collection_artifacts').select('artifacts(id, title, type, updated_at)').eq('collection_id', collection.id),
      supabase.from('collection_files').select('files(id, name, size_bytes)').eq('collection_id', collection.id),
      supabase.from('collection_todos').select('todos(id, title, done, due_date)').eq('collection_id', collection.id),
    ])
    const pluck = (rows: unknown, key: string) =>
      ((rows ?? []) as Array<Record<string, unknown>>).map((r) => r[key]).filter(Boolean)
    setItems({
      artifacts: pluck(a.data, 'artifacts') as Items['artifacts'],
      files: pluck(f.data, 'files') as Items['files'],
      todos: pluck(t.data, 'todos') as Items['todos'],
    })
  }, [collection.id])

  useEffect(() => {
    loadItems()
  }, [loadItems])

  async function save(patch: Partial<Collection>) {
    const { data } = await supabase
      .from('collections')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', collection.id)
      .select()
      .single()
    if (data) onChanged()
  }

  async function removeItem(table: 'collection_artifacts' | 'collection_files' | 'collection_todos', col: string, id: string) {
    await supabase
      .from(table as 'collection_artifacts')
      .delete()
      .eq('collection_id', collection.id)
      .eq(col as 'artifact_id', id)
    loadItems()
    onChanged()
  }

  async function deleteCollection() {
    if (!confirm(`Delete collection “${collection.name}”? The items themselves are kept.`)) return
    await supabase.from('collections').delete().eq('id', collection.id)
    onDeleted()
  }

  const total = items ? items.artifacts.length + items.files.length + items.todos.length : 0

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border bg-surface px-5 py-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded-lg p-1.5 text-muted hover:bg-surface-hover md:hidden" aria-label="Back">
            <ArrowRightIcon className="h-5 w-5 rotate-180" />
          </button>
          <h2 className="flex min-w-0 flex-1 items-center gap-2 text-lg font-semibold text-text">
            <CollectionIcon className="h-5 w-5 shrink-0 text-primary" />
            <span className="truncate">{collection.name}</span>
          </h2>
          <button
            onClick={() => navigate(`/chat?collection=${collection.id}`)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong"
          >
            <ChatIcon className="h-4 w-4" /> Chat with this
          </button>
          {isOwner && (
            <button
              onClick={() => setEditing((v) => !v)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover"
            >
              {editing ? 'Close' : 'Manage'}
            </button>
          )}
        </div>
        {collection.description && !editing && (
          <p className="mt-1.5 text-sm text-muted">{collection.description}</p>
        )}
        <div className="mt-3 max-w-sm">
          <ContextMeter tokens={tokens} model={model} />
        </div>

        {editing && isOwner && (
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            <input
              defaultValue={collection.name}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== collection.name) save({ name: v })
              }}
              className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              placeholder="Collection name"
            />
            <textarea
              defaultValue={collection.description}
              onBlur={(e) => {
                if (e.target.value !== collection.description) save({ description: e.target.value })
              }}
              rows={2}
              className="w-full resize-none rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              placeholder="Description (optional)"
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={collection.visibility === 'workspace'}
                  onChange={(e) => save({ visibility: e.target.checked ? 'workspace' : 'private' })}
                />
                Share with the workspace (anyone can view &amp; add)
              </label>
              <button
                onClick={deleteCollection}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                <TrashIcon className="h-4 w-4" /> Delete collection
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Contents */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {!items ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : total === 0 ? (
          <div className="rounded-2xl border border-dashed border-border-strong py-14 text-center">
            <p className="text-sm text-muted">This collection is empty.</p>
            <p className="mt-1 text-xs text-faint">
              Add items from the Artifacts, Files and To-dos pages (select → “Add to collection”).
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <Section title="Artifacts" icon={ArtifactIcon} count={items.artifacts.length}>
              {items.artifacts.map((a) => (
                <Row
                  key={a.id}
                  onOpen={() => navigate(`/artifacts/${a.id}`)}
                  onRemove={() => removeItem('collection_artifacts', 'artifact_id', a.id)}
                  title={a.title}
                  meta={`${a.type} · ${formatDate(a.updated_at)}`}
                />
              ))}
            </Section>
            <Section title="Files" icon={FileIcon} count={items.files.length}>
              {items.files.map((f) => (
                <Row
                  key={f.id}
                  onOpen={() => navigate('/files')}
                  onRemove={() => removeItem('collection_files', 'file_id', f.id)}
                  title={f.name}
                  meta={formatBytes(f.size_bytes)}
                />
              ))}
            </Section>
            <Section title="To-dos" icon={TodoIcon} count={items.todos.length}>
              {items.todos.map((t) => (
                <Row
                  key={t.id}
                  onOpen={() => navigate('/todos')}
                  onRemove={() => removeItem('collection_todos', 'todo_id', t.id)}
                  title={t.title}
                  meta={`${t.done ? 'done' : 'open'}${t.due_date ? ` · due ${t.due_date}` : ''}`}
                />
              ))}
            </Section>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  icon: Icon,
  count,
  children,
}: {
  title: string
  icon: (p: { className?: string }) => JSX.Element
  count: number
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
        <Icon className="h-4 w-4" /> {title} ({count})
      </h3>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">{children}</div>
    </div>
  )
}

function Row({
  title,
  meta,
  onOpen,
  onRemove,
}: {
  title: string
  meta: string
  onOpen: () => void
  onRemove: () => void
}) {
  return (
    <div className="group flex items-center gap-3 px-4 py-2.5">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-medium text-text group-hover:text-primary">{title}</p>
        <p className="truncate text-[11px] uppercase tracking-wide text-faint">{meta}</p>
      </button>
      <button
        onClick={onRemove}
        title="Remove from this collection"
        className="rounded-md p-1 text-faint opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  )
}
