import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { AddToCollectionBar } from '../components/AddToCollectionBar'
import { CollectionPicker } from '../components/CollectionPicker'
import {
  ArrowRightIcon,
  CloseIcon,
  CollectionIcon,
  PlusIcon,
  SearchIcon,
  TerminologyIcon,
  TrashIcon,
  UsersIcon,
} from '../components/icons'

// Stable identity for "nothing picked" — the picker memoizes on `selected`.
const EMPTY_SELECTION: Set<string> = new Set()

type Term = Database['public']['Tables']['terminology']['Row']
type Collection = Database['public']['Tables']['collections']['Row']

export default function TerminologyPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { termId } = useParams()
  const [terms, setTerms] = useState<Term[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [members, setMembers] = useState<Record<string, Set<string>>>({})
  const [loading, setLoading] = useState(true)

  const [quickTerm, setQuickTerm] = useState('')
  const [quickDefinition, setQuickDefinition] = useState('')
  const [adding, setAdding] = useState(false)
  const [activeCollection, setActiveCollection] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    const [tRes, cRes, mRes] = await Promise.all([
      supabase.from('terminology').select('*').order('term', { ascending: true }),
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('collection_terminology').select('collection_id, term_id'),
    ])
    setTerms(tRes.data ?? [])
    setCollections(cRes.data ?? [])
    const map: Record<string, Set<string>> = {}
    for (const row of mRes.data ?? []) {
      const set = (map[row.collection_id] ??= new Set())
      set.add(row.term_id)
    }
    setMembers(map)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const selectedIds = useMemo(() => [...selected], [selected])

  // The visible list: collection filter → search filter → alphabetical sort.
  const visible = useMemo(() => {
    let filtered = terms
    if (activeCollection) {
      const memberSet = members[activeCollection] ?? new Set<string>()
      filtered = filtered.filter((t) => memberSet.has(t.id))
    }
    const q = search.trim().toLowerCase()
    if (q) {
      filtered = filtered.filter((t) => t.term.toLowerCase().includes(q) || t.definition.toLowerCase().includes(q))
    }
    return filtered.sort((a, b) => a.term.localeCompare(b.term))
  }, [terms, members, activeCollection, search])

  // --- mutations -----------------------------------------------------------

  async function addQuick() {
    const term = quickTerm.trim()
    const definition = quickDefinition.trim()
    if (!term || !definition || !user || adding) return
    setAdding(true)
    const { data, error } = await supabase
      .from('terminology')
      .insert({ owner_id: user.id, term, definition, visibility: 'private' })
      .select('*')
      .single()
    setAdding(false)
    if (!error && data) {
      setTerms((prev) => [...prev, data])
      setQuickTerm('')
      setQuickDefinition('')
      // If filtering by a collection, file the new term into it so it shows up.
      if (activeCollection) {
        await supabase.from('collection_terminology').upsert(
          { collection_id: activeCollection, term_id: data.id, added_by: user.id },
          { onConflict: 'collection_id,term_id', ignoreDuplicates: true },
        )
        setMembers((prev) => {
          const set = new Set(prev[activeCollection] ?? [])
          set.add(data.id)
          return { ...prev, [activeCollection]: set }
        })
      }
    }
  }

  async function deleteTerm(id: string) {
    setTerms((prev) => prev.filter((t) => t.id !== id))
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    if (termId === id) navigate('/terminology')
    await supabase.from('terminology').delete().eq('id', id)
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
  }

  // --- render --------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted">Loading terminology...</p>
      </div>
    )
  }

  // Counts follow the current search, so the picker's "hide empty" rule also
  // hides collections whose terms the query filtered out.
  const visibleIds = new Set(visible.map((t) => t.id))
  const collectionCounts: Record<string, number> = {}
  for (const c of collections) {
    let n = 0
    for (const id of members[c.id] ?? []) if (visibleIds.has(id)) n++
    collectionCounts[c.id] = n
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-text">
              <TerminologyIcon className="h-6 w-6 text-muted" /> Terminology
            </h1>
            <p className="mt-1 text-sm text-muted">
              {terms.length} {terms.length === 1 ? 'term' : 'terms'} · build your shared glossary
            </p>
          </div>
        </div>

        {/* Quick add */}
        <div className="mt-5">
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={quickTerm}
              onChange={(e) => setQuickTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                  e.preventDefault()
                  document.getElementById('quick-definition')?.focus()
                }
              }}
              placeholder="Term..."
              className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
            />
            <div className="flex gap-2">
              <input
                id="quick-definition"
                type="text"
                value={quickDefinition}
                onChange={(e) => setQuickDefinition(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addQuick()}
                placeholder="Definition..."
                className="flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
              />
              <button
                onClick={addQuick}
                disabled={!quickTerm.trim() || !quickDefinition.trim() || adding}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
              >
                <PlusIcon className="h-4 w-4" /> Add
              </button>
            </div>
          </div>
        </div>

        {/* Quick search */}
        <div className="relative mt-3">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search terms..."
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

        {/* Collection filter — one searchable control (see CollectionPicker). */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <CollectionPicker
            collections={collections}
            selected={activeCollection ? new Set([activeCollection]) : EMPTY_SELECTION}
            onChange={(next) => setActiveCollection([...next][0] ?? null)}
            counts={collectionCounts}
            mode="single"
            totalLabel={String(terms.length)}
          />
        </div>

        {/* Term list */}
        <div className="mt-5">
          {loading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted">
              {search.trim()
                ? `No terms match "${search.trim()}".`
                : activeCollection
                  ? 'No terms in this collection yet.'
                  : 'Nothing here yet — add your first term above.'}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {visible.map((t) => (
                <li
                  key={t.id}
                  className={`group flex items-center gap-2.5 rounded-lg border bg-surface px-2.5 py-2.5 ${
                    selected.has(t.id) ? 'border-primary' : 'border-border'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={() => toggleSelect(t.id)}
                    className="h-4 w-4 shrink-0 rounded border-border-strong text-primary"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-text">{t.term}</span>
                      {t.visibility === 'workspace' && (
                        <span
                          title="Shared with workspace"
                          className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
                        >
                          Team
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted">{t.definition}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-100 transition md:opacity-0 md:group-hover:opacity-100">
                    <button
                      onClick={() => navigate(`/terminology/${t.id}`)}
                      title="Open"
                      aria-label="Open term"
                      className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-primary"
                    >
                      <ArrowRightIcon className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Floating "add to collection" bar */}
      {selected.size > 0 && (
        <AddToCollectionBar
          kind="term"
          selectedIds={selectedIds}
          onClear={clearSelection}
        />
      )}

      {/* URL-addressed term detail */}
      {termId && (
        <TermDetailModal
          key={termId}
          termId={termId}
          onClose={() => navigate('/terminology')}
          onPatched={(id, patch) => {
            setTerms((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
          }}
          onDeleted={(id) => {
            deleteTerm(id)
            navigate('/terminology')
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Term detail — a URL-addressed modal (/terminology/:termId). Opened from a
// row's "Open" button, a collection item, or the global ⌘K search, so a link
// points straight at the term and back returns to the list. Self-fetches its
// row (the deep-link case where the page just loaded), edits it in place, and
// syncs the persisted change back into the list via onPatched — no reload.
// ---------------------------------------------------------------------------
function TermDetailModal({
  termId,
  onClose,
  onPatched,
  onDeleted,
}: {
  termId: string
  onClose: () => void
  onPatched: (id: string, patch: Partial<Term>) => void
  onDeleted: (id: string) => void
}) {
  const [term, setTerm] = useState<Term | null | 'missing'>(null)
  const [termText, setTermText] = useState('')
  const [definition, setDefinition] = useState('')
  const [notes, setNotes] = useState('')
  const [collections, setCollections] = useState<Collection[]>([])
  const [members, setMembers] = useState<Set<string>>(new Set())

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from('terminology').select('*').eq('id', termId).maybeSingle(),
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('collection_terminology').select('collection_id').eq('term_id', termId),
    ]).then(([tRes, cRes, mRes]) => {
      if (cancelled) return
      if (!tRes.data) return setTerm('missing')
      setTerm(tRes.data)
      setTermText(tRes.data.term)
      setDefinition(tRes.data.definition)
      setNotes(tRes.data.notes ?? '')
      setCollections(cRes.data ?? [])
      setMembers(new Set((mRes.data ?? []).map((r) => r.collection_id)))
    })
    return () => {
      cancelled = true
    }
  }, [termId])

  // Persist an edit + reflect it in the modal and the parent list.
  async function persist(patch: Partial<Term>) {
    if (!term || term === 'missing') return
    setTerm({ ...term, ...patch })
    onPatched(termId, patch)
    await supabase.from('terminology').update(patch).eq('id', termId)
  }

  function saveTerm() {
    const t = termText.trim()
    if (term && term !== 'missing' && t && t !== term.term) persist({ term: t })
    else if (term && term !== 'missing') setTermText(term.term) // revert empty edit
  }

  function saveDefinition() {
    const d = definition.trim()
    if (term && term !== 'missing' && d && d !== term.definition) persist({ definition: d })
    else if (term && term !== 'missing') setDefinition(term.definition)
  }

  function saveNotes() {
    if (term && term !== 'missing' && notes !== (term.notes ?? '')) persist({ notes })
  }

  async function removeFromCollection(collectionId: string) {
    await supabase.from('collection_terminology').delete().eq('collection_id', collectionId).eq('term_id', termId)
    setMembers((prev) => {
      const next = new Set(prev)
      next.delete(collectionId)
      return next
    })
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <TerminologyIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-text">
              {term === 'missing' ? 'Not found' : term ? 'Term' : 'Loading…'}
            </h3>
            {term && term !== 'missing' && (
              <p className="mt-0.5 text-xs text-faint">
                {term.visibility === 'workspace' ? 'Shared with workspace' : 'Private'}
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-faint hover:bg-surface-hover hover:text-text" aria-label="Close">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {term === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : term === 'missing' ? (
            <p className="text-sm text-muted">This term doesn't exist or you don't have access to it.</p>
          ) : (
            <div className="space-y-4">
              {/* Term */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">Term</label>
                <input
                  value={termText}
                  onChange={(e) => setTermText(e.target.value)}
                  onBlur={saveTerm}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  placeholder="Term"
                  className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base font-medium outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
                />
              </div>

              {/* Definition */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">Definition</label>
                <textarea
                  value={definition}
                  onChange={(e) => setDefinition(e.target.value)}
                  onBlur={saveDefinition}
                  rows={3}
                  placeholder="Definition…"
                  className="w-full resize-y rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
                />
              </div>

              {/* Notes */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={saveNotes}
                  rows={4}
                  placeholder="Additional context, examples, or related information…"
                  className="w-full resize-y rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
                />
              </div>

              {/* Visibility */}
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">Visibility</label>
                <button
                  onClick={() => persist({ visibility: term.visibility === 'workspace' ? 'private' : 'workspace' })}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                    term.visibility === 'workspace' ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:bg-surface-hover'
                  }`}
                >
                  {term.visibility === 'workspace' ? (
                    <>
                      <UsersIcon className="h-4 w-4" /> Shared with workspace
                    </>
                  ) : (
                    <>Only me</>
                  )}
                </button>
              </div>

              {/* Collections */}
              {collections.filter((c) => members.has(c.id)).length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">Collections</label>
                  <div className="space-y-2">
                    {collections
                      .filter((c) => members.has(c.id))
                      .map((c) => (
                        <div key={c.id} className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2">
                          <div className="flex items-center gap-2">
                            <CollectionIcon className="h-4 w-4 text-muted" />
                            <span className="text-sm">{c.name}</span>
                          </div>
                          <button
                            onClick={() => removeFromCollection(c.id)}
                            className="text-xs text-faint hover:text-muted"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {term && term !== 'missing' && (
          <div className="flex items-center gap-2 border-t border-border px-5 py-3">
            <button
              onClick={() => {
                if (confirm('Delete this term?')) onDeleted(termId)
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
