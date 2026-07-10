import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { AddToCollectionBar } from '../components/AddToCollectionBar'
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

  const openTerm = useMemo(() => terms.find((t) => t.id === termId), [terms, termId])

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

  async function patchTerm(id: string, patch: Partial<Term>) {
    setTerms((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    await supabase.from('terminology').update(patch).eq('id', id)
  }

  function toggleVisibility(t: Term) {
    patchTerm(t.id, { visibility: t.visibility === 'workspace' ? 'private' : 'workspace' })
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

  const filteredCollections =
    activeCollection || search
      ? collections.filter((c) => {
          const memberSet = members[c.id] ?? new Set<string>()
          return visible.some((t) => memberSet.has(t.id))
        })
      : collections

  return (
    <div className="flex h-full">
      {/* Left: term list */}
      <div className="flex flex-1 flex-col border-r border-divider">
        <header className="flex items-center justify-between border-b border-divider p-4">
          <div className="flex items-center gap-2">
            <TerminologyIcon className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">Terminology</h1>
            <span className="text-sm text-faint">({terms.length})</span>
          </div>
        </header>

        {/* Quick add */}
        <div className="border-b border-divider p-3">
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
              className="w-full rounded border border-divider bg-surface px-3 py-2 text-sm transition placeholder:text-faint focus:border-primary focus:outline-none"
            />
            <div className="flex gap-2">
              <input
                id="quick-definition"
                type="text"
                value={quickDefinition}
                onChange={(e) => setQuickDefinition(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addQuick()}
                placeholder="Definition..."
                className="flex-1 rounded border border-divider bg-surface px-3 py-2 text-sm transition placeholder:text-faint focus:border-primary focus:outline-none"
              />
              <button
                onClick={addQuick}
                disabled={!quickTerm.trim() || !quickDefinition.trim() || adding}
                className="flex h-10 shrink-0 items-center gap-2 rounded bg-primary px-3 text-sm font-medium text-white transition hover:bg-primary-hover disabled:opacity-50"
              >
                <PlusIcon className="h-4 w-4" /> Add
              </button>
            </div>
          </div>
        </div>

        {/* Search & filters */}
        <div className="border-b border-divider p-3">
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search terms..."
              className="w-full rounded border border-divider bg-surface py-2 pl-9 pr-3 text-sm transition placeholder:text-faint focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        {/* Collection filter chips */}
        {filteredCollections.length > 0 && (
          <div className="border-b border-divider p-3">
            <div className="flex flex-wrap gap-2">
              {activeCollection && (
                <button
                  onClick={() => setActiveCollection(null)}
                  className="rounded bg-surface-2 px-2 py-1 text-xs text-muted hover:bg-surface-3"
                >
                  All terms
                </button>
              )}
              {filteredCollections.map((c) => {
                const count = [...(members[c.id] ?? [])].filter((tid) => visible.some((t) => t.id === tid)).length
                return (
                  <button
                    key={c.id}
                    onClick={() => setActiveCollection(activeCollection === c.id ? null : c.id)}
                    className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition ${
                      activeCollection === c.id ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-muted hover:bg-surface-3'
                    }`}
                  >
                    <CollectionIcon className="h-3 w-3" />
                    {c.name}
                    <span className="text-faint">({count})</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Term list */}
        <div className="flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center">
              <TerminologyIcon className="mb-2 h-12 w-12 text-faint" />
              <p className="text-sm text-muted">No terms yet</p>
              <p className="mt-1 text-xs text-faint">Add terms above to build your glossary</p>
            </div>
          ) : (
            <div className="divide-y divide-divider">
              {visible.map((t) => (
                <button
                  key={t.id}
                  onClick={() => navigate(`/terminology/${t.id}`)}
                  className={`group flex w-full items-center gap-3 p-3 text-left transition hover:bg-surface-2 ${
                    termId === t.id ? 'bg-surface-2' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={(e) => {
                      e.stopPropagation()
                      toggleSelect(t.id)
                    }}
                    className="h-4 w-4 shrink-0 rounded border-divider text-primary"
                  />
                  <div className="flex-1 overflow-hidden">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{t.term}</span>
                      {t.visibility === 'workspace' && <UsersIcon className="h-3 w-3 shrink-0 text-faint" />}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted">{t.definition}</p>
                  </div>
                  <ArrowRightIcon className="h-4 w-4 shrink-0 text-faint opacity-0 transition group-hover:opacity-100" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: term detail */}
      {openTerm ? (
        <div className="flex w-full max-w-2xl flex-col">
          <header className="flex items-center justify-between border-b border-divider p-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate('/terminology')}
                className="flex h-8 w-8 items-center justify-center rounded border border-divider transition hover:bg-surface-2"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
              <h2 className="text-lg font-semibold">Term Details</h2>
            </div>
            <button
              onClick={() => deleteTerm(openTerm.id)}
              className="flex items-center gap-2 rounded px-3 py-2 text-sm font-medium text-red-500 transition hover:bg-red-500/10"
            >
              <TrashIcon className="h-4 w-4" /> Delete
            </button>
          </header>

          <div className="flex-1 overflow-y-auto p-6">
            <div className="space-y-6">
              <div>
                <label className="mb-2 block text-sm font-medium text-muted">Term</label>
                <input
                  type="text"
                  value={openTerm.term}
                  onChange={(e) => patchTerm(openTerm.id, { term: e.target.value })}
                  className="w-full rounded border border-divider bg-surface px-3 py-2 transition focus:border-primary focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-muted">Definition</label>
                <textarea
                  value={openTerm.definition}
                  onChange={(e) => patchTerm(openTerm.id, { definition: e.target.value })}
                  rows={3}
                  className="w-full rounded border border-divider bg-surface px-3 py-2 transition focus:border-primary focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-muted">Notes (optional)</label>
                <textarea
                  value={openTerm.notes}
                  onChange={(e) => patchTerm(openTerm.id, { notes: e.target.value })}
                  rows={4}
                  placeholder="Additional context, examples, or related information..."
                  className="w-full rounded border border-divider bg-surface px-3 py-2 transition placeholder:text-faint focus:border-primary focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-muted">Visibility</label>
                <button
                  onClick={() => toggleVisibility(openTerm)}
                  className={`flex items-center gap-2 rounded border px-3 py-2 text-sm font-medium transition ${
                    openTerm.visibility === 'workspace' ? 'border-primary bg-primary-soft text-primary' : 'border-divider hover:bg-surface-2'
                  }`}
                >
                  <UsersIcon className="h-4 w-4" />
                  {openTerm.visibility === 'workspace' ? 'Shared with workspace' : 'Only me'}
                </button>
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-muted">Collections</label>
                <div className="space-y-2">
                  {collections
                    .filter((c) => members[c.id]?.has(openTerm.id))
                    .map((c) => (
                      <div key={c.id} className="flex items-center justify-between rounded border border-divider bg-surface-2 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <CollectionIcon className="h-4 w-4 text-muted" />
                          <span className="text-sm">{c.name}</span>
                        </div>
                        <button
                          onClick={async () => {
                            await supabase.from('collection_terminology').delete().eq('collection_id', c.id).eq('term_id', openTerm.id)
                            await load()
                          }}
                          className="text-xs text-faint hover:text-muted"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex w-full max-w-2xl items-center justify-center">
          <div className="text-center">
            <TerminologyIcon className="mx-auto mb-3 h-12 w-12 text-faint" />
            <p className="text-sm text-muted">Select a term to view details</p>
          </div>
        </div>
      )}

      {/* AddToCollectionBar overlay */}
      {selected.size > 0 && (
        <AddToCollectionBar
          kind="term"
          selectedIds={selectedIds}
          onClear={clearSelection}
        />
      )}
    </div>
  )
}
