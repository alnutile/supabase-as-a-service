import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { streamChat, type ChatMessage } from '../lib/chat'
import { uploadPickedFile } from '../lib/upload'
import { fetchLinkMeta, normalizeUrl } from '../lib/links'
import { useAuth } from '../contexts/AuthContext'
import { Markdown } from '../components/Markdown'
import { formatBytes, formatDate } from '../lib/util'
import { estimateTokensFromChars } from '../lib/tokens'
import { useOrchestratorContext } from '../lib/useModelContext'
import { ContextMeter } from '../components/ContextMeter'
import {
  ArrowRightIcon,
  ArtifactIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CollectionIcon,
  FileIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  PlusIcon,
  SendIcon,
  TableIcon,
  TodoIcon,
  TrashIcon,
} from '../components/icons'

type Collection = Database['public']['Tables']['collections']['Row']
type Kind = 'artifact' | 'file' | 'table' | 'todo' | 'link'

// Per-kind wiring: the base table it lives in, the join table, and the join's
// item column — so one set of helpers handles every content type.
const KINDS: Record<
  Kind,
  { title: string; icon: (p: { className?: string }) => JSX.Element; base: string; link: string; col: string; label: string }
> = {
  todo: { title: 'To-dos', icon: TodoIcon, base: 'todos', link: 'collection_todos', col: 'todo_id', label: 'title' },
  artifact: { title: 'Artifacts', icon: ArtifactIcon, base: 'artifacts', link: 'collection_artifacts', col: 'artifact_id', label: 'title' },
  file: { title: 'Files', icon: FileIcon, base: 'files', link: 'collection_files', col: 'file_id', label: 'name' },
  table: { title: 'Tables', icon: TableIcon, base: 'user_tables', link: 'collection_tables', col: 'table_id', label: 'name' },
  link: { title: 'Links', icon: LinkIcon, base: 'links', link: 'collection_links', col: 'link_id', label: 'title' },
}
const KIND_ORDER: Kind[] = ['todo', 'artifact', 'file', 'table', 'link']

// URL segment for each kind: /collections/:collectionId/todos/:itemId etc.
const KIND_TO_SLUG: Record<Kind, string> = { todo: 'todos', artifact: 'artifacts', file: 'files', table: 'tables', link: 'links' }
const SLUG_TO_KIND: Record<string, Kind> = Object.fromEntries(Object.entries(KIND_TO_SLUG).map(([k, s]) => [s, k as Kind]))

type Item = { id: string; label: string; meta?: string }
type Items = Record<Kind, Item[]>

export default function CollectionsPage() {
  const { user } = useAuth()
  const model = useOrchestratorContext()
  const navigate = useNavigate()
  // Selection lives in the URL (/collections/:collectionId[/:kindSlug/:itemId])
  // so a collection — and an open item — can be bookmarked and back works.
  const { collectionId, kindSlug, itemId } = useParams()
  const selectedId = collectionId ?? null
  const openItemKind = kindSlug ? SLUG_TO_KIND[kindSlug] ?? null : null

  const [collections, setCollections] = useState<Collection[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [tokens, setTokens] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    const [cRes, caRes, cfRes, ctRes, cuRes, clRes, stats] = await Promise.all([
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('collection_artifacts').select('collection_id'),
      supabase.from('collection_files').select('collection_id'),
      supabase.from('collection_todos').select('collection_id'),
      supabase.from('collection_tables').select('collection_id'),
      supabase.from('collection_links').select('collection_id'),
      supabase.rpc('collection_token_stats'),
    ])
    setCollections(cRes.data ?? [])
    const c: Record<string, number> = {}
    for (const res of [caRes, cfRes, ctRes, cuRes, clRes]) {
      for (const r of res.data ?? []) c[r.collection_id] = (c[r.collection_id] ?? 0) + 1
    }
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
        navigate(`/collections/${data.id}`)
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* List pane */}
      <div className={`w-full shrink-0 flex-col border-r border-border bg-surface ${selected ? 'hidden md:flex md:w-72' : 'flex md:w-72'}`}>
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
              <p className="mt-1 text-xs text-faint">Group content into a collection, then chat with the whole set at once.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {collections.map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate(`/collections/${c.id}`)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition ${
                    c.id === selectedId ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-hover hover:text-text'
                  }`}
                >
                  <CollectionIcon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="block truncate text-[11px] text-faint">
                      {counts[c.id] ?? 0} item{(counts[c.id] ?? 0) === 1 ? '' : 's'}
                      {tokens[c.id] ? ` · ≈${Math.round(tokens[c.id] / 100) / 10}k tok` : ''}
                    </span>
                  </span>
                  {c.visibility === 'workspace' ? (
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
      <div className={`relative min-w-0 flex-1 ${selected ? 'flex' : 'hidden md:flex'} flex-col bg-bg`}>
        {selected ? (
          <CollectionDashboard
            key={selected.id}
            collection={selected}
            isOwner={selected.owner_id === user?.id}
            tokens={tokens[selected.id] ?? 0}
            model={model}
            openItem={openItemKind && itemId ? { kind: openItemKind, id: itemId } : null}
            onBack={() => navigate('/collections')}
            onChanged={load}
            onDeleted={() => {
              navigate('/collections')
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
                A collection groups to-dos, artifacts, files, tables and links so you can see them on one dashboard and chat with the whole set at once.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dashboard: a collection's contents as cards, + a floating chat bubble
// ---------------------------------------------------------------------------
function CollectionDashboard({
  collection,
  isOwner,
  tokens,
  model,
  openItem,
  onBack,
  onChanged,
  onDeleted,
}: {
  collection: Collection
  isOwner: boolean
  tokens: number
  model: ReturnType<typeof useOrchestratorContext>
  openItem: { kind: Kind; id: string } | null
  onBack: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const [items, setItems] = useState<Items | null>(null)
  const [editing, setEditing] = useState(false)

  // Which cards are collapsed, remembered per collection across visits.
  const collapseKey = `collections:collapsed:${collection.id}`
  const [collapsed, setCollapsed] = useState<Partial<Record<Kind, boolean>>>(() => {
    try {
      return JSON.parse(localStorage.getItem(collapseKey) ?? '{}')
    } catch {
      return {}
    }
  })
  function toggleCollapsed(kind: Kind, next?: boolean) {
    setCollapsed((prev) => {
      const v = { ...prev, [kind]: next ?? !prev[kind] }
      localStorage.setItem(collapseKey, JSON.stringify(v))
      return v
    })
  }

  const loadItems = useCallback(async () => {
    const [a, f, t, u, l] = await Promise.all([
      supabase.from('collection_artifacts').select('artifacts(id, title, type, updated_at)').eq('collection_id', collection.id),
      supabase.from('collection_files').select('files(id, name, size_bytes)').eq('collection_id', collection.id),
      supabase.from('collection_todos').select('todos(id, title, done, due_date)').eq('collection_id', collection.id),
      supabase.from('collection_tables').select('user_tables(id, name, updated_at)').eq('collection_id', collection.id),
      supabase.from('collection_links').select('links(id, title, url)').eq('collection_id', collection.id),
    ])
    const pluck = (rows: unknown, key: string) =>
      ((rows ?? []) as Array<Record<string, unknown>>).map((r) => r[key]).filter(Boolean) as Array<Record<string, unknown>>
    setItems({
      todo: pluck(t.data, 'todos').map((x) => ({
        id: String(x.id),
        label: String(x.title),
        meta: `${x.done ? 'done' : 'open'}${x.due_date ? ` · due ${x.due_date}` : ''}`,
      })),
      artifact: pluck(a.data, 'artifacts').map((x) => ({
        id: String(x.id),
        label: String(x.title),
        meta: `${x.type} · ${formatDate(String(x.updated_at))}`,
      })),
      file: pluck(f.data, 'files').map((x) => ({ id: String(x.id), label: String(x.name), meta: formatBytes(Number(x.size_bytes ?? 0)) })),
      table: pluck(u.data, 'user_tables').map((x) => ({ id: String(x.id), label: String(x.name), meta: `updated ${formatDate(String(x.updated_at))}` })),
      link: pluck(l.data, 'links').map((x) => {
        let host = String(x.url)
        try {
          host = new URL(String(x.url)).hostname.replace(/^www\./, '')
        } catch {
          // keep the raw url
        }
        return { id: String(x.id), label: String(x.title) || host, meta: host }
      }),
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

  async function removeItem(kind: Kind, id: string) {
    const cfg = KINDS[kind]
    await supabase
      .from(cfg.link as 'collection_artifacts')
      .delete()
      .eq('collection_id', collection.id)
      .eq(cfg.col as 'artifact_id', id)
    loadItems()
    onChanged()
  }

  async function addItem(kind: Kind, id: string) {
    const cfg = KINDS[kind]
    await supabase
      .from(cfg.link as 'collection_artifacts')
      .upsert({ collection_id: collection.id, [cfg.col]: id } as never, { onConflict: `collection_id,${cfg.col}`, ignoreDuplicates: true })
    loadItems()
    onChanged()
  }

  // Create a brand-new item of `kind` (named `label`) and file it into this
  // collection. Files come in via uploadFiles instead (they need a real upload).
  async function createAndAdd(kind: Exclude<Kind, 'file'>, label: string) {
    const name = label.trim()
    if (!name || !user) return
    let id: string | null = null
    if (kind === 'todo') {
      const { data } = await supabase.from('todos').insert({ owner_id: user.id, title: name, visibility: 'private' }).select('id').single()
      id = data?.id ?? null
    } else if (kind === 'artifact') {
      const { data } = await supabase
        .from('artifacts')
        .insert({ owner_id: user.id, title: name, type: 'markdown', content: '', visibility: 'private' })
        .select('id')
        .single()
      id = data?.id ?? null
    } else if (kind === 'table') {
      const { data } = await supabase.rpc('create_user_table', {
        p_name: name,
        p_columns: [{ key: 'name', label: 'Name', type: 'text' }],
        p_visibility: 'private',
      })
      const created = (Array.isArray(data) ? data[0] : data) as { id?: string } | null
      id = created?.id ?? null
    } else if (kind === 'link') {
      const url = normalizeUrl(name)
      if (!url) return
      const { data } = await supabase
        .from('links')
        .insert({ owner_id: user.id, url, title: new URL(url).hostname.replace(/^www\./, ''), visibility: 'private' })
        .select('id')
        .single()
      id = data?.id ?? null
      // Enrich with server-fetched metadata in the background; the card
      // already shows the hostname, so adding never blocks on a slow site.
      if (id) {
        const linkId = id
        fetchLinkMeta(url).then(async (meta) => {
          if (!meta) return
          await supabase
            .from('links')
            .update({ title: meta.title, description: meta.description, image_url: meta.image_url, favicon_url: meta.favicon_url })
            .eq('id', linkId)
          loadItems()
        })
      }
    }
    if (id) await addItem(kind, id)
  }

  async function uploadFiles(files: FileList) {
    if (!user) return
    for (const file of Array.from(files)) {
      const path = `${user.id}/${crypto.randomUUID()}/${file.name}`
      const size = await uploadPickedFile(path, file)
      const { data } = await supabase
        .from('files')
        .insert({ owner_id: user.id, bucket: 'files', path, name: file.name, mime_type: file.type || null, size_bytes: size, visibility: 'private' })
        .select('id')
        .single()
      if (data?.id) await addItem('file', data.id)
    }
  }

  async function deleteCollection() {
    if (!confirm(`Delete collection “${collection.name}”? The items themselves are kept.`)) return
    await supabase.from('collections').delete().eq('id', collection.id)
    onDeleted()
  }

  // Open an item in a modal, addressed by URL so back/forward/bookmark work:
  // /collections/:collectionId/todos/:itemId etc.
  const viewItem = (kind: Kind, id: string) => {
    navigate(`/collections/${collection.id}/${KIND_TO_SLUG[kind]}/${id}`)
  }
  const closeItem = () => {
    // Prefer history back (keeps back/forward sane); fall back to the plain
    // collection URL when the modal URL was opened directly (deep link).
    if (location.key !== 'default') navigate(-1)
    else navigate(`/collections/${collection.id}`, { replace: true })
  }

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
            className="hidden items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover sm:flex"
            title="Open the full chat scoped to this collection"
          >
            <ChatIcon className="h-4 w-4" /> Full chat
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
        {collection.description && !editing && <p className="mt-1.5 text-sm text-muted">{collection.description}</p>}
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

      {/* Cards */}
      <div className="flex-1 overflow-y-auto px-5 py-4 pb-28">
        {!items ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {KIND_ORDER.map((kind) => (
              <Card
                key={kind}
                kind={kind}
                items={items[kind]}
                collapsed={!!collapsed[kind]}
                onToggleCollapsed={() => toggleCollapsed(kind)}
                onExpand={() => toggleCollapsed(kind, false)}
                onOpen={(id) => viewItem(kind, id)}
                onRemove={(id) => removeItem(kind, id)}
                onAdd={(id) => addItem(kind, id)}
                onCreate={kind === 'file' ? undefined : (label) => createAndAdd(kind, label)}
                onUpload={kind === 'file' ? uploadFiles : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* Floating chat bubble — chat with this collection, add things to it */}
      <CollectionChat collection={collection} onChanged={() => { loadItems(); onChanged() }} />

      {/* URL-addressed item viewer */}
      {openItem && (
        <ItemModal
          kind={openItem.kind}
          id={openItem.id}
          onClose={closeItem}
          onChanged={() => {
            loadItems()
            onChanged()
          }}
        />
      )}
    </div>
  )
}

// A single content-type card: its items + create-new / add-existing.
function Card({
  kind,
  items,
  collapsed,
  onToggleCollapsed,
  onExpand,
  onOpen,
  onRemove,
  onAdd,
  onCreate,
  onUpload,
}: {
  kind: Kind
  items: Item[]
  collapsed: boolean
  onToggleCollapsed: () => void
  onExpand: () => void
  onOpen: (id: string) => void
  onRemove: (id: string) => void
  onAdd: (id: string) => void
  onCreate?: (label: string) => void | Promise<void>
  onUpload?: (files: FileList) => void | Promise<void>
}) {
  const cfg = KINDS[kind]
  const Icon = cfg.icon
  const [adding, setAdding] = useState(false)
  const [candidates, setCandidates] = useState<Item[] | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const present = useMemo(() => new Set(items.map((i) => i.id)), [items])

  const noun = cfg.title.replace(/s$/, '').toLowerCase()

  async function openPicker() {
    const next = !adding
    setAdding(next)
    if (next) onExpand() // adding to a collapsed card should show the picker
    if (!next || candidates) return
    const { data } = await supabase.from(cfg.base as 'artifacts').select(`id, ${cfg.label}`).limit(200)
    setCandidates(((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), label: String(r[cfg.label]) })))
  }

  async function create() {
    const name = newName.trim()
    if (!name || !onCreate || busy) return
    setBusy(true)
    try {
      await onCreate(name)
      setNewName('')
      setAdding(false)
    } finally {
      setBusy(false)
    }
  }

  const addable = (candidates ?? []).filter((c) => !present.has(c.id))

  return (
    <div className={`flex flex-col rounded-xl border border-border bg-surface ${collapsed ? 'self-start' : ''}`}>
      <div className={`flex items-center gap-2 px-4 py-2.5 ${collapsed ? '' : 'border-b border-border'}`}>
        <button
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={collapsed ? `Expand ${cfg.title}` : `Collapse ${cfg.title}`}
        >
          <ChevronDownIcon className={`h-3.5 w-3.5 shrink-0 text-faint transition-transform ${collapsed ? '-rotate-90' : ''}`} />
          <Icon className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-sm font-semibold text-text">{cfg.title}</span>
          <span className="text-xs text-faint">{items.length}</span>
        </button>
        <button
          onClick={openPicker}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary-soft"
        >
          <PlusIcon className="h-3.5 w-3.5" /> Add
        </button>
      </div>

      {!collapsed && adding && (
        <div className="border-b border-border bg-surface-2/40">
          {/* Create new */}
          <div className="flex items-center gap-1.5 px-3 py-2">
            {onUpload ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={async (e) => {
                    if (e.target.files?.length) {
                      setBusy(true)
                      try {
                        await onUpload(e.target.files)
                        setAdding(false)
                      } finally {
                        setBusy(false)
                        if (fileRef.current) fileRef.current.value = ''
                      }
                    }
                  }}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border-strong px-2 py-1.5 text-xs font-medium text-primary hover:bg-primary-soft disabled:opacity-50"
                >
                  <PlusIcon className="h-3.5 w-3.5" /> {busy ? 'Uploading…' : 'Upload new file'}
                </button>
              </>
            ) : (
              onCreate && (
                <>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        create()
                      }
                    }}
                    placeholder={`New ${noun}…`}
                    className="min-w-0 flex-1 rounded-md border border-border-strong px-2 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
                  />
                  <button
                    onClick={create}
                    disabled={!newName.trim() || busy}
                    className="shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-primary-strong disabled:opacity-50"
                  >
                    Create
                  </button>
                </>
              )
            )}
          </div>

          {/* Add existing */}
          <div className="max-h-44 overflow-y-auto border-t border-border">
            {candidates === null ? (
              <p className="px-4 py-3 text-xs text-faint">Loading…</p>
            ) : addable.length === 0 ? (
              <p className="px-4 py-3 text-xs text-faint">No existing {cfg.title.toLowerCase()} to add.</p>
            ) : (
              addable.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    onAdd(c.id)
                    setAdding(false)
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-text hover:bg-surface-hover"
                >
                  <PlusIcon className="h-3.5 w-3.5 shrink-0 text-faint" />
                  <span className="truncate">{c.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {!collapsed && (
      <div className="min-h-[3rem] divide-y divide-border">
        {items.length === 0 ? (
          <p className="px-4 py-4 text-xs text-faint">None yet.</p>
        ) : (
          items.map((i) => (
            <div key={i.id} className="group flex items-center gap-3 px-4 py-2">
              <button onClick={() => onOpen(i.id)} className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm font-medium text-text group-hover:text-primary">{i.label}</p>
                {i.meta && <p className="truncate text-[11px] uppercase tracking-wide text-faint">{i.meta}</p>}
              </button>
              <button
                onClick={() => onRemove(i.id)}
                title="Remove from this collection"
                aria-label="Remove"
                className="rounded-md p-1 text-faint opacity-100 transition hover:bg-red-50 hover:text-red-600 md:opacity-0 md:group-hover:opacity-100"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item viewer modal — addressed by URL (/collections/:id/:kindSlug/:itemId)
// so viewing an item keeps you in the collection and back returns to it.
// ---------------------------------------------------------------------------
type ItemDetail = {
  title: string
  meta?: string
  body?: JSX.Element
  fullPageTo?: string // in-app route for the dedicated area
  externalHref?: string // e.g. the link's URL or a file's signed URL
  externalLabel?: string
}

function ItemModal({ kind, id, onClose, onChanged }: { kind: Kind; id: string; onClose: () => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const cfg = KINDS[kind]
  const Icon = cfg.icon
  const [detail, setDetail] = useState<ItemDetail | null | 'missing'>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const load = useCallback(async () => {
    if (kind === 'todo') {
      const { data } = await supabase.from('todos').select('*').eq('id', id).maybeSingle()
      if (!data) return setDetail('missing')
      setDetail({
        title: data.title,
        meta: `${data.done ? 'Done' : 'Open'}${data.due_date ? ` · due ${data.due_date}` : ''}`,
        fullPageTo: '/todos',
        body: data.notes ? <p className="whitespace-pre-wrap text-sm text-text">{data.notes}</p> : undefined,
      })
    } else if (kind === 'artifact') {
      const { data } = await supabase.from('artifacts').select('id, title, type, language, content, updated_at').eq('id', id).maybeSingle()
      if (!data) return setDetail('missing')
      setDetail({
        title: data.title,
        meta: `${data.type} · updated ${formatDate(data.updated_at)}`,
        fullPageTo: `/artifacts/${data.id}`,
        body:
          data.type === 'markdown' ? (
            <div className="prose-sm max-w-none">
              <Markdown>{data.content}</Markdown>
            </div>
          ) : (
            <pre className="max-w-full overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs text-text">{data.content}</pre>
          ),
      })
    } else if (kind === 'file') {
      const { data } = await supabase.from('files').select('*').eq('id', id).maybeSingle()
      if (!data) return setDetail('missing')
      const { data: signed } = await supabase.storage.from(data.bucket).createSignedUrl(data.path, 3600)
      const isImage = (data.mime_type ?? '').startsWith('image/')
      setDetail({
        title: data.name,
        meta: `${data.mime_type ?? 'file'} · ${formatBytes(data.size_bytes ?? 0)} · ${formatDate(data.created_at)}`,
        fullPageTo: '/files',
        externalHref: signed?.signedUrl,
        externalLabel: 'Download / open file',
        body:
          isImage && signed?.signedUrl ? (
            <img src={signed.signedUrl} alt={data.name} className="max-h-96 w-auto rounded-lg border border-border" />
          ) : undefined,
      })
    } else if (kind === 'table') {
      const { data } = await supabase.from('user_tables').select('*').eq('id', id).maybeSingle()
      if (!data) return setDetail('missing')
      const cols = (Array.isArray(data.columns) ? data.columns : []) as Array<{ key?: string; label?: string; type?: string }>
      setDetail({
        title: data.name,
        meta: `updated ${formatDate(data.updated_at)}`,
        fullPageTo: '/tables',
        body: (
          <div>
            {data.description && <p className="mb-3 text-sm text-muted">{data.description}</p>}
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Columns</p>
            <ul className="space-y-1">
              {cols.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-text">
                  <span className="font-medium">{c.label ?? c.key}</span>
                  <span className="text-xs text-faint">{c.type}</span>
                </li>
              ))}
            </ul>
          </div>
        ),
      })
    } else {
      const { data } = await supabase.from('links').select('*').eq('id', id).maybeSingle()
      if (!data) return setDetail('missing')
      setDetail({
        title: data.title || data.url,
        meta: data.url,
        fullPageTo: '/links',
        externalHref: data.url,
        externalLabel: 'Visit link',
        body: (
          <div className="space-y-3">
            {data.image_url && <img src={data.image_url} alt="" className="max-h-56 w-auto rounded-lg border border-border" />}
            {data.description && <p className="text-sm text-muted">{data.description}</p>}
            {data.notes && <p className="whitespace-pre-wrap text-sm text-text">{data.notes}</p>}
          </div>
        ),
      })
    }
  }, [kind, id])

  useEffect(() => {
    load()
  }, [load])

  // Quick done/undone without leaving the collection (to-dos only).
  async function toggleTodoDone() {
    if (busy) return
    setBusy(true)
    try {
      const { data } = await supabase.from('todos').select('done').eq('id', id).maybeSingle()
      if (data) {
        await supabase
          .from('todos')
          .update({ done: !data.done, completed_at: !data.done ? new Date().toISOString() : null })
          .eq('id', id)
        await load()
        onChanged()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-text">
              {detail && detail !== 'missing' ? detail.title : detail === 'missing' ? 'Not found' : 'Loading…'}
            </h3>
            {detail && detail !== 'missing' && detail.meta && <p className="mt-0.5 truncate text-xs text-faint">{detail.meta}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-text" aria-label="Close">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {detail === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : detail === 'missing' ? (
            <p className="text-sm text-muted">This {cfg.title.replace(/s$/, '').toLowerCase()} doesn’t exist or you don’t have access to it.</p>
          ) : (
            detail.body ?? <p className="text-sm text-faint">No further details.</p>
          )}
        </div>

        {detail && detail !== 'missing' && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
            {kind === 'todo' && (
              <button
                onClick={toggleTodoDone}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover disabled:opacity-50"
              >
                <CheckIcon className="h-4 w-4" /> {detail.meta?.startsWith('Done') ? 'Reopen' : 'Mark done'}
              </button>
            )}
            {detail.externalHref && (
              <a
                href={detail.externalHref}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-hover"
              >
                <LinkIcon className="h-4 w-4" /> {detail.externalLabel ?? 'Open'}
              </a>
            )}
            {detail.fullPageTo && (
              <button
                onClick={() => navigate(detail.fullPageTo!)}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-strong"
              >
                Open full page <ArrowRightIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Floating "chat with this collection" bubble. Scopes the chat to the
// collection's content and nudges the assistant to file new items into it.
function CollectionChat({ collection, onChanged }: { collection: Collection; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming])

  const system =
    `You are the assistant for the "${collection.name}" collection. Its current contents (to-dos, artifacts, files, tables, links) are provided as context. ` +
    `When the user asks to add a task, note, document, or link, USE YOUR TOOLS (create_todo, add_note, create_artifact, save_link, …) and file it into the "${collection.name}" collection (pass collection: "${collection.name}"). ` +
    `Prefer tools over emitting artifact blocks. Keep replies short and practical.`

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    const history: ChatMessage[] = [...messages.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }]
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setSending(true)
    setStreaming('')
    try {
      const full = await streamChat(history, (d) => setStreaming((s) => (s ?? '') + d), {
        system,
        collectionIds: [collection.id],
      })
      setMessages((prev) => [...prev, { role: 'assistant', content: full }])
      onChanged() // the assistant may have added a to-do / artifact to the collection
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `⚠️ ${err instanceof Error ? err.message : 'Chat failed'}` }])
    } finally {
      setStreaming(null)
      setSending(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title={`Chat with "${collection.name}"`}
        className="absolute bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white shadow-lg transition hover:bg-primary-strong"
        style={{ boxShadow: '0 10px 30px rgba(99,84,232,.45)' }}
      >
        <ChatIcon className="h-6 w-6" />
      </button>
    )
  }

  return (
    <div className="absolute bottom-5 right-5 z-30 flex h-[70%] max-h-[560px] w-[calc(100%-2.5rem)] max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <CollectionIcon className="h-4 w-4 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{collection.name}</span>
        <button onClick={() => setOpen(false)} className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-text" aria-label="Close chat">
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && streaming === null && (
          <p className="px-2 py-6 text-center text-xs text-faint">
            Ask about this collection, or say “add a task to …”, “make a note that …”. New items land back in this collection.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-primary text-white' : 'border border-border bg-surface text-text'
              }`}
            >
              {m.role === 'user' ? <span className="whitespace-pre-wrap">{m.content}</span> : <Markdown>{m.content}</Markdown>}
            </div>
          </div>
        ))}
        {streaming !== null && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl border border-border bg-surface px-3 py-2 text-sm text-text">
              <Markdown>{streaming || '…'}</Markdown>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={1}
            placeholder={`Message “${collection.name}”…`}
            className="max-h-28 min-h-[38px] flex-1 resize-none rounded-xl border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition hover:bg-primary-strong disabled:opacity-50"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
