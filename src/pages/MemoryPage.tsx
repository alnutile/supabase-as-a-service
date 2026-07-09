import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  CloseIcon,
  MemoryIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from '../components/icons'

type Memory = Database['public']['Tables']['user_memories']['Row']

// Suggested categories — free text underneath, but these drive the quick picker.
const CATEGORIES = ['general', 'preference', 'fact', 'context', 'project'] as const

// A pin glyph as inline SVG so we don't depend on a new icon export.
function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 3 3H7l3-3-1-6z" />
    </svg>
  )
}

export default function MemoryPage() {
  const { user } = useAuth()
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)

  const [quickText, setQuickText] = useState('')
  const [quickCategory, setQuickCategory] = useState<string>('general')
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('user_memories')
      .select('*')
      .order('pinned', { ascending: false })
      .order('updated_at', { ascending: false })
    setMemories(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Live updates — memory is written by the assistant/agents too, so reflect
  // those without a manual refresh (owner-scoped by RLS).
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel('user_memories_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_memories' }, () => load())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user, load])

  const categoriesPresent = useMemo(() => {
    const set = new Set<string>()
    for (const m of memories) set.add(m.category)
    return [...set].sort()
  }, [memories])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return memories.filter((m) => {
      if (activeCategory && m.category !== activeCategory) return false
      if (q && !m.content.toLowerCase().includes(q)) return false
      return true
    })
  }, [memories, search, activeCategory])

  // --- mutations -----------------------------------------------------------

  async function addQuick() {
    const content = quickText.trim()
    if (!content || !user || adding) return
    setAdding(true)
    const { data, error } = await supabase
      .from('user_memories')
      .insert({ owner_id: user.id, content, category: quickCategory })
      .select('*')
      .single()
    setAdding(false)
    if (!error && data) {
      setMemories((prev) => [data, ...prev])
      setQuickText('')
    }
  }

  async function patch(id: string, p: Partial<Memory>) {
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, ...p } : m)))
    await supabase.from('user_memories').update(p).eq('id', id)
  }

  async function remove(id: string) {
    setMemories((prev) => prev.filter((m) => m.id !== id))
    await supabase.from('user_memories').delete().eq('id', id)
  }

  // --- render --------------------------------------------------------------

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-text">
              <MemoryIcon className="h-6 w-6 text-muted" /> Memory
            </h1>
            <p className="mt-1 text-sm text-muted">
              What the assistant remembers about you — injected at the start of every new chat. Private to you; the AI writes here too.
            </p>
          </div>
        </div>

        {/* Quick add */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <input
            value={quickText}
            onChange={(e) => setQuickText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addQuick()
              }
            }}
            placeholder="Remember something about yourself (e.g. “Answer in metric units”)…"
            className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
          />
          <select
            value={quickCategory}
            onChange={(e) => setQuickCategory(e.target.value)}
            className="rounded-lg border border-border-strong bg-surface px-2 py-2.5 text-sm text-muted outline-none focus:border-primary"
            aria-label="Category"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            onClick={addQuick}
            disabled={!quickText.trim() || adding}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" /> Add
          </button>
        </div>

        {/* Search */}
        <div className="relative mt-3">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search memories…"
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

        {/* Category filter */}
        {categoriesPresent.length > 1 && (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveCategory(null)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                activeCategory === null
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              All ({memories.length})
            </button>
            {categoriesPresent.map((c) => (
              <button
                key={c}
                onClick={() => setActiveCategory(c)}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium capitalize transition ${
                  activeCategory === c
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-muted hover:bg-surface-hover'
                }`}
              >
                {c} ({memories.filter((m) => m.category === c).length})
              </button>
            ))}
          </div>
        )}

        {/* List */}
        <div className="mt-5">
          {loading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted">
              {search.trim() || activeCategory
                ? 'No memories match.'
                : 'Nothing remembered yet — add a fact above, or just tell the assistant in chat (“remember that I…”).'}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {visible.map((m) => (
                <MemoryRow
                  key={m.id}
                  memory={m}
                  onChangeContent={(content) =>
                    content.trim() && content !== m.content && patch(m.id, { content: content.trim() })
                  }
                  onTogglePin={() => patch(m.id, { pinned: !m.pinned })}
                  onDelete={() => remove(m.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function MemoryRow({
  memory,
  onChangeContent,
  onTogglePin,
  onDelete,
}: {
  memory: Memory
  onChangeContent: (content: string) => void
  onTogglePin: () => void
  onDelete: () => void
}) {
  const [content, setContent] = useState(memory.content)
  useEffect(() => setContent(memory.content), [memory.content])

  return (
    <li
      className={`group flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border bg-surface px-2.5 py-2 md:flex-nowrap ${
        memory.pinned ? 'border-primary/50' : 'border-border'
      }`}
    >
      <button
        onClick={onTogglePin}
        title={memory.pinned ? 'Pinned — always injected first' : 'Pin this memory'}
        className={`shrink-0 rounded-md p-1 transition ${
          memory.pinned ? 'text-primary' : 'text-faint hover:text-muted'
        }`}
      >
        <PinGlyph filled={memory.pinned} />
      </button>

      <input
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onBlur={() => onChangeContent(content)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none"
      />

      <div className="order-last flex w-full items-center gap-2 md:order-none md:w-auto">
        {memory.category !== 'general' && (
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
            {memory.category}
          </span>
        )}
        {memory.key && (
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-mono text-faint" title="Stable key — the assistant updates this memory in place">
            {memory.key}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1 opacity-100 transition md:ml-0 md:opacity-0 md:group-hover:opacity-100">
          <button
            onClick={onDelete}
            title="Forget"
            aria-label="Forget this memory"
            className="rounded-md p-1 text-faint hover:bg-surface-hover hover:text-red-600"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </li>
  )
}
