import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { estimateTokensFromChars, formatCount } from '../lib/tokens'
import { useOrchestratorContext } from '../lib/useModelContext'
import { ContextMeter } from '../components/ContextMeter'
import { generateMarkdownContent, generateFilename, downloadMarkdown } from '../lib/artifactDownload'
import {
  ArtifactIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  CollectionIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  DownloadIcon,
} from '../components/icons'

type Artifact = Database['public']['Tables']['artifacts']['Row']
type Collection = Database['public']['Tables']['collections']['Row']

const VIS_ICON = { private: LockIcon, unlisted: LinkIcon, public: GlobeIcon }

export default function ArtifactsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  // collectionId -> set of artifact ids that belong to it.
  const [members, setMembers] = useState<Record<string, Set<string>>>({})
  const [loading, setLoading] = useState(true)
  const model = useOrchestratorContext()

  // Server-side search across every artifact (title or body), not just the
  // page-loaded set. `searchResults` is null when no search is active.
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Artifact[] | null>(null)
  const [searching, setSearching] = useState(false)

  // Filter the grid to one collection (null = everything). Backed by the
  // `?collection=<id>` URL param so the selection survives navigation — the
  // browser Back button returns to the collection you were viewing (issue #82).
  const activeId = searchParams.get('collection')
  const setActiveId = useCallback(
    (id: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (id) next.set('collection', id)
          else next.delete('collection')
          return next
        },
        { replace: false },
      )
    },
    [setSearchParams],
  )
  // Filter by visibility (null = all). Backed by the `?visibility=<type>` URL
  // param so the selection survives navigation.
  const activeVisibility = searchParams.get('visibility') as 'private' | 'unlisted' | 'public' | null
  const setActiveVisibility = useCallback(
    (vis: 'private' | 'unlisted' | 'public' | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (vis) next.set('visibility', vis)
          else next.delete('visibility')
          return next
        },
        { replace: false },
      )
    },
    [setSearchParams],
  )
  // Multi-select state for bulk "add to collection".
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const [aRes, cRes, mRes] = await Promise.all([
      supabase.from('artifacts').select('*').order('updated_at', { ascending: false }),
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('collection_artifacts').select('collection_id, artifact_id'),
    ])
    setArtifacts(aRes.data ?? [])
    setCollections(cRes.data ?? [])
    const map: Record<string, Set<string>> = {}
    for (const row of mRes.data ?? []) {
      const set = (map[row.collection_id] ??= new Set())
      set.add(row.artifact_id)
    }
    setMembers(map)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Close the add-to-collection menu on an outside click.
  useEffect(() => {
    if (!showAdd) return
    const onClick = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setShowAdd(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showAdd])

  // Debounced full-DB search by title or body. Hits Postgres (case-insensitive
  // `ilike`) so it finds matches anywhere, not just in the already-loaded grid.
  useEffect(() => {
    const term = search.trim()
    if (!term) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const handle = setTimeout(async () => {
      // Strip characters that would break PostgREST's `or` filter grammar.
      const pattern = `%${term.replace(/[,()\\%]/g, ' ')}%`
      const { data } = await supabase
        .from('artifacts')
        .select('*')
        .or(`title.ilike.${pattern},content.ilike.${pattern}`)
        .order('updated_at', { ascending: false })
        .limit(200)
      setSearchResults(data ?? [])
      setSearching(false)
    }, 250)
    return () => clearTimeout(handle)
  }, [search])

  const activeCollection = collections.find((c) => c.id === activeId) ?? null

  const visible = useMemo(() => {
    let base = searchResults ?? artifacts
    // Filter by collection if one is selected
    if (activeId) {
      const set = members[activeId] ?? new Set()
      base = base.filter((a) => set.has(a.id))
    }
    // Filter by visibility if one is selected
    if (activeVisibility) {
      base = base.filter((a) => a.visibility === activeVisibility)
    }
    return base
  }, [artifacts, searchResults, members, activeId, activeVisibility])

  // Estimated tokens per collection (content chars ÷ ~4), kept in sync with
  // membership automatically since we already hold every artifact's content.
  const tokensByCollection = useMemo(() => {
    const chars: Record<string, number> = {}
    const byId = new Map(artifacts.map((a) => [a.id, a.content?.length ?? 0]))
    for (const [cid, set] of Object.entries(members)) {
      let total = 0
      for (const id of set) total += byId.get(id) ?? 0
      chars[cid] = estimateTokensFromChars(total)
    }
    return chars
  }, [artifacts, members])

  async function create() {
    const { data, error } = await supabase
      .from('artifacts')
      .insert({
        owner_id: user!.id,
        title: 'Untitled artifact',
        type: 'markdown',
        content: '# Untitled\n\nStart writing…',
        visibility: 'private',
      })
      .select()
      .single()
    if (!error && data) navigate(`/artifacts/${data.id}`)
  }

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

  const selectedIds = useMemo(() => [...selected], [selected])

  // Whether every selected artifact is already in collection `cid`.
  function allSelectedIn(cid: string): boolean {
    const set = members[cid] ?? new Set()
    return selectedIds.length > 0 && selectedIds.every((id) => set.has(id))
  }

  // Toggle the selected artifacts in/out of a collection.
  async function toggleMembership(cid: string) {
    if (!selectedIds.length || busy) return
    setBusy(true)
    const adding = !allSelectedIn(cid)
    try {
      if (adding) {
        await supabase.from('collection_artifacts').upsert(
          selectedIds.map((artifact_id) => ({ collection_id: cid, artifact_id, added_by: user!.id })),
          { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
        )
      } else {
        await supabase
          .from('collection_artifacts')
          .delete()
          .eq('collection_id', cid)
          .in('artifact_id', selectedIds)
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

  // Create a collection and immediately file the selected artifacts into it.
  async function createCollection() {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      const { data, error } = await supabase
        .from('collections')
        .insert({ owner_id: user!.id, name, visibility: 'private' })
        .select()
        .single()
      if (error || !data) return
      setCollections((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
      setNewName('')
      if (selectedIds.length) {
        await supabase.from('collection_artifacts').upsert(
          selectedIds.map((artifact_id) => ({ collection_id: data.id, artifact_id, added_by: user!.id })),
          { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
        )
        setMembers((prev) => ({ ...prev, [data.id]: new Set(selectedIds) }))
      }
    } finally {
      setBusy(false)
    }
  }

  // Remove one artifact from the collection currently being viewed.
  async function removeFromActive(artifactId: string) {
    if (!activeId) return
    await supabase
      .from('collection_artifacts')
      .delete()
      .eq('collection_id', activeId)
      .eq('artifact_id', artifactId)
    setMembers((prev) => {
      const next = { ...prev }
      const set = new Set(next[activeId] ?? [])
      set.delete(artifactId)
      next[activeId] = set
      return next
    })
  }

  async function deleteCollection(c: Collection) {
    if (!confirm(`Delete collection “${c.name}”? The artifacts themselves are kept.`)) return
    await supabase.from('collections').delete().eq('id', c.id)
    setCollections((prev) => prev.filter((x) => x.id !== c.id))
    setMembers((prev) => {
      const next = { ...prev }
      delete next[c.id]
      return next
    })
    if (activeId === c.id) setActiveId(null)
    setEditing(false)
  }

  async function saveCollection(patch: Partial<Collection>) {
    if (!activeCollection) return
    const { data } = await supabase
      .from('collections')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', activeCollection.id)
      .select()
      .single()
    if (data) setCollections((prev) => prev.map((c) => (c.id === data.id ? data : c)))
  }

  const ownsActive = activeCollection?.owner_id === user?.id

  function downloadSelectedAsMarkdown() {
    const selectedArtifacts = artifacts.filter((a) => selected.has(a.id))
    if (selectedArtifacts.length === 0) return

    const content = generateMarkdownContent(selectedArtifacts, formatDate)
    const filename = generateFilename(selectedArtifacts)
    downloadMarkdown(content, filename)
  }

  async function togglePin(id: string, currentlyPinned: boolean) {
    // Optimistically update local state
    setArtifacts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, pinned: !currentlyPinned } : a))
    )
    // Update in database
    await supabase
      .from('artifacts')
      .update({ pinned: !currentlyPinned })
      .eq('id', id)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Artifacts</h1>
            <p className="mt-1 text-sm text-muted">
              Documents and snippets. Group them into collections to chat with a focused set.
            </p>
          </div>
          <button
            onClick={create}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong"
          >
            <PlusIcon className="h-4 w-4" /> New artifact
          </button>
        </div>

        {/* Search the whole DB by title or body */}
        <div className="relative mb-5">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search artifacts by title or content…"
            className="w-full rounded-lg border border-border-strong bg-surface py-2 pl-9 pr-9 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-faint transition hover:bg-surface-hover hover:text-text"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Collection filter bar */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setActiveId(null)}
            className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
              activeId === null
                ? 'border-primary bg-primary-soft text-primary'
                : 'border-border text-muted hover:bg-surface-hover'
            }`}
          >
            All ({artifacts.length})
          </button>
          {collections.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setActiveId(c.id)
                setEditing(false)
              }}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                activeId === c.id
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              <CollectionIcon className="h-3.5 w-3.5" />
              {c.name} ({(members[c.id] ?? new Set()).size})
              {(tokensByCollection[c.id] ?? 0) > 0 && (
                <span className="text-[10px] text-faint">≈{formatCount(tokensByCollection[c.id])} tok</span>
              )}
              {c.visibility === 'workspace' && (
                <span className="text-[10px] uppercase tracking-wide text-faint">shared</span>
              )}
            </button>
          ))}
        </div>

        {/* Visibility filter bar */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Visibility:</span>
          {(['private', 'unlisted', 'public'] as const).map((vis) => {
            const Icon = VIS_ICON[vis]
            const count = artifacts.filter((a) => a.visibility === vis).length
            return (
              <button
                key={vis}
                onClick={() => setActiveVisibility(activeVisibility === vis ? null : vis)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                  activeVisibility === vis
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-muted hover:bg-surface-hover'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {vis.charAt(0).toUpperCase() + vis.slice(1)} ({count})
              </button>
            )
          })}
          {activeVisibility && (
            <button
              onClick={() => setActiveVisibility(null)}
              className="text-xs font-medium text-muted hover:text-text"
            >
              Clear
            </button>
          )}
        </div>

        {/* Active-collection header: chat + manage */}
        {activeCollection && (
          <div className="mb-5 rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 font-semibold text-text">
                  <CollectionIcon className="h-4 w-4 text-primary" />
                  {activeCollection.name}
                </h2>
                {activeCollection.description && (
                  <p className="mt-0.5 text-xs text-muted">{activeCollection.description}</p>
                )}
              </div>
              <div className="w-full md:w-64 md:flex-none">
                <ContextMeter tokens={tokensByCollection[activeCollection.id] ?? 0} model={model} />
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => navigate(`/chat?collection=${activeCollection.id}`)}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-primary-strong"
                >
                  <ChatIcon className="h-4 w-4" /> Chat with this
                </button>
                {visible.length > 0 && (
                  <button
                    onClick={() => {
                      const content = generateMarkdownContent(visible, formatDate)
                      const filename = `${activeCollection.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_collection_${new Date().toISOString().split('T')[0]}.md`
                      downloadMarkdown(content, filename)
                    }}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-semibold text-text transition hover:bg-surface-hover"
                  >
                    <DownloadIcon className="h-4 w-4" /> Download all
                  </button>
                )}
                {ownsActive && (
                  <button
                    onClick={() => setEditing((v) => !v)}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:bg-surface-hover"
                  >
                    {editing ? 'Close' : 'Manage'}
                  </button>
                )}
              </div>
            </div>

            {editing && ownsActive && (
              <div className="mt-3 space-y-3 border-t border-border pt-3">
                <input
                  defaultValue={activeCollection.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v && v !== activeCollection.name) saveCollection({ name: v })
                  }}
                  className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  placeholder="Collection name"
                />
                <textarea
                  defaultValue={activeCollection.description}
                  onBlur={(e) => {
                    const v = e.target.value
                    if (v !== activeCollection.description) saveCollection({ description: v })
                  }}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-border-strong px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
                  placeholder="Description (optional)"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input
                      type="checkbox"
                      checked={activeCollection.visibility === 'workspace'}
                      onChange={(e) =>
                        saveCollection({ visibility: e.target.checked ? 'workspace' : 'private' })
                      }
                    />
                    Share with the workspace (anyone can view & add)
                  </label>
                  <button
                    onClick={() => deleteCollection(activeCollection)}
                    className="ml-auto flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50"
                  >
                    <TrashIcon className="h-4 w-4" /> Delete collection
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {loading || (searching && !searchResults) ? (
          <p className="text-sm text-faint">{searching ? 'Searching…' : 'Loading…'}</p>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border-strong py-16 text-center">
            <ArtifactIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
            <p className="text-sm text-muted">
              {searchResults
                ? `No artifacts match “${search.trim()}”.`
                : activeId
                  ? 'No artifacts in this collection yet.'
                  : 'No artifacts yet.'}
            </p>
            {!activeId && !searchResults && (
              <button onClick={create} className="mt-3 text-sm font-medium text-primary hover:underline">
                Create your first one
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {visible.map((a) => {
              const VisIcon = VIS_ICON[a.visibility]
              const isSelected = selected.has(a.id)
              return (
                <div
                  key={a.id}
                  className={`group relative rounded-xl border bg-surface p-4 text-left transition hover:shadow-sm ${
                    isSelected ? 'border-primary ring-1 ring-primary-soft' : 'border-border hover:border-brand-300'
                  }`}
                >
                  {/* Selection checkbox */}
                  <button
                    onClick={() => toggleSelect(a.id)}
                    aria-label={isSelected ? 'Deselect' : 'Select'}
                    className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-md border transition ${
                      isSelected
                        ? 'border-primary bg-primary text-white'
                        : 'border-border-strong bg-surface text-transparent opacity-100 hover:text-faint md:opacity-0 md:group-hover:opacity-100'
                    }`}
                  >
                    <CheckIcon className="h-3.5 w-3.5" />
                  </button>

                  {/* Pin button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      togglePin(a.id, a.pinned)
                    }}
                    title={a.pinned ? 'Unpin from Home' : 'Pin to Home'}
                    className={`absolute right-2 top-2 rounded-md p-1 transition ${
                      a.pinned
                        ? 'text-primary opacity-100 hover:bg-primary-soft'
                        : 'text-faint opacity-100 hover:bg-surface-hover md:opacity-0 md:group-hover:opacity-100'
                    } ${activeId ? 'right-9' : ''}`}
                  >
                    <PinIcon className="h-4 w-4" />
                  </button>

                  <button onClick={() => navigate(`/artifacts/${a.id}`)} className="block w-full text-left">
                    <div className="flex items-start justify-between pl-6 pr-6">
                      <h3 className="truncate font-medium text-text group-hover:text-primary">{a.title}</h3>
                      <VisIcon className="h-4 w-4 shrink-0 text-faint" />
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted">
                      {a.content.replace(/[#*`>]/g, '').slice(0, 120) || 'Empty'}
                    </p>
                    <p className="mt-3 text-[11px] uppercase tracking-wide text-faint">
                      {a.type} · {formatDate(a.updated_at)}
                    </p>
                  </button>

                  {activeId && (
                    <button
                      onClick={() => removeFromActive(a.id)}
                      title="Remove from this collection"
                      className="absolute bottom-2 right-2 rounded-md p-1 text-faint opacity-100 transition hover:bg-red-50 hover:text-red-600 md:opacity-0 md:group-hover:opacity-100"
                    >
                      <CloseIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Floating bulk-action bar when artifacts are selected */}
      {selected.size > 0 && (
        <div className="pointer-events-none sticky bottom-0 left-0 right-0 z-20 flex justify-center px-4 pb-6">
          <div
            ref={addRef}
            className="pointer-events-auto relative flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-2.5 shadow-lg"
          >
            <span className="text-sm font-medium text-text">{selected.size} selected</span>
            <button
              onClick={() => setShowAdd((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-primary-strong"
            >
              <CollectionIcon className="h-4 w-4" /> Add to collection
            </button>
            <button
              onClick={downloadSelectedAsMarkdown}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-text transition hover:bg-surface-hover"
            >
              <DownloadIcon className="h-4 w-4" /> Download as MD
            </button>
            <button
              onClick={clearSelection}
              className="text-sm font-medium text-muted hover:text-text"
            >
              Clear
            </button>

            {showAdd && (
              <div className="absolute bottom-full left-0 mb-2 max-h-72 w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-xl">
                {collections.length > 0 && (
                  <div className="mb-1 space-y-0.5">
                    {collections.map((c) => {
                      const checked = allSelectedIn(c.id)
                      return (
                        <button
                          key={c.id}
                          disabled={busy}
                          onClick={() => toggleMembership(c.id)}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50"
                        >
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              checked ? 'border-primary bg-primary text-white' : 'border-border-strong text-transparent'
                            }`}
                          >
                            <CheckIcon className="h-3 w-3" />
                          </span>
                          <CollectionIcon className="h-3.5 w-3.5 shrink-0 text-faint" />
                          <span className="min-w-0 flex-1 truncate text-text">{c.name}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
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
    </div>
  )
}
