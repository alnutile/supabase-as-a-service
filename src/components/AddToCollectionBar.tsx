import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { CheckIcon, CollectionIcon } from './icons'

type Collection = Database['public']['Tables']['collections']['Row']

// Which join table + column a given content kind uses. Collections are
// multi-content: artifacts, files, tables (+ more) all link the same way, so
// this one bar serves every page that wants to file things into a collection.
const KIND = {
  file: { table: 'collection_files', col: 'file_id', noun: 'file' },
  table: { table: 'collection_tables', col: 'table_id', noun: 'table' },
  artifact: { table: 'collection_artifacts', col: 'artifact_id', noun: 'artifact' },
  link: { table: 'collection_links', col: 'link_id', noun: 'link' },
  agent: { table: 'collection_agents', col: 'agent_id', noun: 'agent' },
} as const

type Kind = keyof typeof KIND

/**
 * Floating "N selected → Add to collection" bar. Drop it on any list page,
 * pass the selected item ids and the content `kind`, and it handles loading
 * collections, toggling membership, and creating a collection inline.
 */
export function AddToCollectionBar({
  kind,
  selectedIds,
  onClear,
}: {
  kind: Kind
  selectedIds: string[]
  onClear: () => void
}) {
  const { user } = useAuth()
  const cfg = KIND[kind]
  const [collections, setCollections] = useState<Collection[]>([])
  // collectionId -> set of selected ids already filed into it.
  const [members, setMembers] = useState<Record<string, Set<string>>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    // The link table/column are chosen at runtime, which the generated types
    // can't track; all link tables are structurally identical, so we cast to a
    // representative one (`collection_files`) and read the dynamic column loosely.
    const [cRes, mRes] = await Promise.all([
      supabase.from('collections').select('*').order('name', { ascending: true }),
      selectedIds.length
        ? supabase
            .from(cfg.table as 'collection_files')
            .select(`collection_id, ${cfg.col}`)
            .in(cfg.col as 'file_id', selectedIds)
        : Promise.resolve({ data: [] }),
    ])
    setCollections(cRes.data ?? [])
    const map: Record<string, Set<string>> = {}
    for (const row of (mRes.data ?? []) as unknown as Array<Record<string, string>>) {
      const set = (map[row.collection_id] ??= new Set())
      set.add(row[cfg.col])
    }
    setMembers(map)
  }, [cfg.table, cfg.col, selectedIds])

  useEffect(() => {
    if (selectedIds.length) refresh()
  }, [refresh, selectedIds.length])

  useEffect(() => {
    if (!showAdd) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowAdd(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showAdd])

  const allIn = useMemo(
    () => (cid: string) => {
      const set = members[cid] ?? new Set()
      return selectedIds.length > 0 && selectedIds.every((id) => set.has(id))
    },
    [members, selectedIds],
  )

  async function toggle(cid: string) {
    if (!selectedIds.length || busy) return
    setBusy(true)
    const adding = !allIn(cid)
    const rows = selectedIds.map((id) => ({ collection_id: cid, [cfg.col]: id, added_by: user!.id }))
    try {
      if (adding) {
        await supabase
          .from(cfg.table as 'collection_files')
          .upsert(rows as never, { onConflict: `collection_id,${cfg.col}`, ignoreDuplicates: true })
      } else {
        await supabase
          .from(cfg.table as 'collection_files')
          .delete()
          .eq('collection_id', cid)
          .in(cfg.col as 'file_id', selectedIds)
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
    if (!name || busy) return
    setBusy(true)
    try {
      const { data } = await supabase
        .from('collections')
        .insert({ owner_id: user!.id, name, visibility: 'private' })
        .select()
        .single()
      if (!data) return
      setCollections((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
      setNewName('')
      const rows = selectedIds.map((id) => ({ collection_id: data.id, [cfg.col]: id, added_by: user!.id }))
      await supabase
        .from(cfg.table as 'collection_files')
        .upsert(rows as never, { onConflict: `collection_id,${cfg.col}`, ignoreDuplicates: true })
      setMembers((prev) => ({ ...prev, [data.id]: new Set(selectedIds) }))
    } finally {
      setBusy(false)
    }
  }

  if (!selectedIds.length) return null

  return (
    <div className="pointer-events-none sticky bottom-0 left-0 right-0 z-20 flex justify-center px-4 pb-6">
      <div
        ref={ref}
        className="pointer-events-auto relative flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-2.5 shadow-lg"
      >
        <span className="text-sm font-medium text-text">{selectedIds.length} selected</span>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-primary-strong"
        >
          <CollectionIcon className="h-4 w-4" /> Add to collection
        </button>
        <button onClick={onClear} className="text-sm font-medium text-muted hover:text-text">
          Clear
        </button>

        {showAdd && (
          <div className="absolute bottom-full left-0 mb-2 max-h-72 w-64 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-xl">
            {collections.length > 0 && (
              <div className="mb-1 space-y-0.5">
                {collections.map((c) => {
                  const checked = allIn(c.id)
                  return (
                    <button
                      key={c.id}
                      disabled={busy}
                      onClick={() => toggle(c.id)}
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
  )
}
