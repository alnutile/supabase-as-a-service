import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { formatDate } from '../lib/util'
import { CheckIcon, CloseIcon, MemoryIcon, PencilIcon, PlusIcon, TrashIcon } from '../components/icons'

type Memory = Database['public']['Tables']['user_memories']['Row']

// The Memory page: durable, per-user facts the assistant remembers about you
// (saved by the `remember` tool in chat, or by hand here). They're private to
// you and injected into the chat system prompt so replies stay personalized
// across conversations. This page lets you see, edit, and forget them.
export default function MemoryPage() {
  const { user } = useAuth()
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)

  const [newContent, setNewContent] = useState('')
  const [adding, setAdding] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('user_memories')
      .select('*')
      .order('created_at', { ascending: false })
    setMemories(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Live sync: the assistant may write memories from chat/agents while this
  // page is open (user_memories is in the realtime publication).
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel('user-memories')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_memories', filter: `owner_id=eq.${user.id}` },
        () => load(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user, load])

  async function add() {
    const content = newContent.trim()
    if (!content || !user || adding) return
    setAdding(true)
    const { data, error } = await supabase
      .from('user_memories')
      .insert({ owner_id: user.id, content })
      .select('*')
      .single()
    setAdding(false)
    if (!error && data) {
      setMemories((prev) => [data, ...prev])
      setNewContent('')
    }
  }

  function startEdit(m: Memory) {
    setEditingId(m.id)
    setEditContent(m.content)
  }

  async function saveEdit(id: string) {
    const content = editContent.trim()
    if (!content) return
    setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, content } : m)))
    setEditingId(null)
    await supabase.from('user_memories').update({ content }).eq('id', id)
  }

  async function remove(id: string) {
    setMemories((prev) => prev.filter((m) => m.id !== id))
    await supabase.from('user_memories').delete().eq('id', id)
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-strong">
          <MemoryIcon className="h-5 w-5 text-primary" />
          Memory
        </h1>
        <p className="mt-1 text-sm text-muted">
          Durable facts the assistant remembers about you — preferences, your role, your
          timezone. These are private to you and used to personalize its replies. The
          assistant can add or update them from chat; you can edit or forget any of them here.
        </p>
      </header>

      {/* Add a memory by hand */}
      <div className="mb-6 flex gap-2">
        <input
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder="Something the assistant should remember about you…"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-strong placeholder:text-faint focus:border-primary focus:outline-none"
        />
        <button
          onClick={add}
          disabled={!newContent.trim() || adding}
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          <PlusIcon className="h-4 w-4" />
          Remember
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : memories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
          Nothing remembered yet. Tell the assistant something worth keeping (“remember that
          I prefer short answers”) or add a note above.
        </div>
      ) : (
        <ul className="space-y-2">
          {memories.map((m) => (
            <li
              key={m.id}
              className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5"
            >
              {editingId === m.id ? (
                <>
                  <input
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit(m.id)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    autoFocus
                    className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-sm text-strong focus:border-primary focus:outline-none"
                  />
                  <button
                    onClick={() => saveEdit(m.id)}
                    className="shrink-0 rounded p-1 text-primary hover:bg-surface-2"
                    title="Save"
                  >
                    <CheckIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="shrink-0 rounded p-1 text-faint hover:bg-surface-2 hover:text-muted"
                    title="Cancel"
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm text-strong">{m.content}</p>
                    <p className="mt-0.5 text-[11px] text-faint">
                      {m.key ? (
                        <span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 font-medium text-muted">
                          {m.key}
                        </span>
                      ) : null}
                      Remembered {formatDate(m.created_at)}
                    </p>
                  </div>
                  <button
                    onClick={() => startEdit(m)}
                    className="shrink-0 rounded p-1 text-faint hover:bg-surface-2 hover:text-muted"
                    title="Edit"
                  >
                    <PencilIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => remove(m.id)}
                    className="shrink-0 rounded p-1 text-faint hover:bg-surface-2 hover:text-red-500"
                    title="Forget"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
