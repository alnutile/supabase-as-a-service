import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { AddToCollectionBar } from '../components/AddToCollectionBar'
import { CardsIcon, CollectionIcon, LockIcon, PlusIcon, UsersIcon } from '../components/icons'
import { formatDate } from '../lib/util'

type CardBoard = Database['public']['Tables']['card_boards']['Row']
type Collection = Database['public']['Tables']['collections']['Row']

// Planner list page for card boards — free-form walls of movable cards. Mirrors
// WhiteboardsPage (list + create → editor + collection filter + AddToCollectionBar).
export default function CardBoardsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [boards, setBoards] = useState<CardBoard[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [members, setMembers] = useState<Record<string, Set<string>>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const activeId = searchParams.get('collection')

  const load = useCallback(async () => {
    const [b, c, m] = await Promise.all([
      supabase.from('card_boards').select('*').order('updated_at', { ascending: false }),
      supabase.from('collections').select('*').order('name', { ascending: true }),
      supabase.from('collection_card_boards').select('collection_id, card_board_id'),
    ])
    setBoards(b.data ?? [])
    setCollections(c.data ?? [])
    const map: Record<string, Set<string>> = {}
    for (const row of m.data ?? []) {
      const set = (map[row.collection_id] ??= new Set())
      set.add(row.card_board_id)
    }
    setMembers(map)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const channel = supabase
      .channel('card-boards-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'card_boards' }, () => load())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [load])

  async function create() {
    if (!user || creating) return
    setCreating(true)
    const { data } = await supabase
      .from('card_boards')
      .insert({ owner_id: user.id, title: 'Untitled board', cards: [], visibility: 'private' })
      .select()
      .single()
    setCreating(false)
    if (data) navigate(`/cards/${data.id}`)
  }

  const setActiveId = (id: string | null) => {
    const next = new URLSearchParams(searchParams)
    if (id) next.set('collection', id)
    else next.delete('collection')
    setSearchParams(next, { replace: true })
  }

  const visible = useMemo(() => {
    if (!activeId) return boards
    const set = members[activeId] ?? new Set()
    return boards.filter((b) => set.has(b.id))
  }, [boards, members, activeId])

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const countCards = (b: CardBoard) => (Array.isArray(b.cards) ? (b.cards as unknown[]).length : 0)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-text">Cards</h1>
              <p className="mt-1 text-sm text-muted">
                Free-form boards of movable cards — dump ideas, drag them to rank by priority. Double-click
                the canvas to add a card. Group boards into collections to chat with them.
              </p>
            </div>
            <button
              onClick={create}
              disabled={creating}
              className="flex shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
            >
              <PlusIcon className="h-4 w-4" /> New board
            </button>
          </div>

          {/* Collection filter */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveId(null)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                activeId === null
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              All ({boards.length})
            </button>
            {collections.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                  activeId === c.id
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-muted hover:bg-surface-hover'
                }`}
              >
                <CollectionIcon className="h-3.5 w-3.5" />
                {c.name} ({(members[c.id] ?? new Set()).size})
                {c.visibility === 'workspace' && (
                  <span className="text-[10px] uppercase tracking-wide text-faint">shared</span>
                )}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border py-16 text-center">
              <CardsIcon className="mx-auto mb-3 h-8 w-8 text-faint" />
              <p className="text-sm text-muted">
                {activeId ? 'No boards in this collection yet.' : 'No card boards yet.'}
              </p>
              <button
                onClick={create}
                disabled={creating}
                className="mt-3 text-sm font-semibold text-primary hover:underline disabled:opacity-50"
              >
                Create your first board →
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((b) => {
                const isSelected = selected.has(b.id)
                return (
                  <div
                    key={b.id}
                    className={`group relative flex flex-col rounded-2xl border bg-surface p-4 transition hover:border-primary ${
                      isSelected ? 'border-primary ring-2 ring-primary-soft' : 'border-border'
                    }`}
                  >
                    <label
                      className="absolute right-3 top-3 z-10 flex h-5 w-5 cursor-pointer items-center justify-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(b.id)}
                        className="h-4 w-4 cursor-pointer accent-[var(--color-primary)]"
                      />
                    </label>
                    <button onClick={() => navigate(`/cards/${b.id}`)} className="flex flex-1 flex-col text-left">
                      <div className="mb-3 flex h-20 items-center justify-center rounded-lg border border-border bg-surface-2 text-faint">
                        <CardsIcon className="h-7 w-7" />
                      </div>
                      <div className="flex items-center gap-1.5">
                        {b.visibility === 'workspace' ? (
                          <UsersIcon className="h-3.5 w-3.5 shrink-0 text-faint" aria-label="Shared with the workspace" />
                        ) : (
                          <LockIcon className="h-3.5 w-3.5 shrink-0 text-faint" aria-label="Private" />
                        )}
                        <h3 className="min-w-0 flex-1 truncate font-medium text-text">{b.title}</h3>
                      </div>
                      <p className="mt-1 text-xs text-faint">
                        {countCards(b)} card{countCards(b) === 1 ? '' : 's'} · updated {formatDate(b.updated_at)}
                      </p>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <AddToCollectionBar kind="card_board" selectedIds={[...selected]} onClear={() => setSelected(new Set())} />
    </div>
  )
}
