import { useCallback, useEffect, useRef, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { streamChat, type ChatMessage } from '../lib/chat'
import { isAbortError } from '../lib/chatError'
import { Markdown } from './Markdown'
import { CloseIcon, SendIcon, SparkleIcon, StopIcon } from './icons'

type Message = Database['public']['Tables']['messages']['Row']

// Persistent chat dock scoped to one user table (the Tables grid's "Ask AI"
// panel). Mirrors BoardChatPanel: backed by a real conversation found-or-created
// for (owner, table_id) in the same conversations/messages tables the main Chat
// uses, so history survives, syncs over realtime, and shows up in the chat list.
// The table's schema + a row preview are injected as context via
// streamChat({ tableId }); the assistant reads/writes rows (query_table /
// add_table_row / update_table_row) and the grid re-renders on the next reload.
export function TableChatPanel({
  tableId,
  tableName,
  onClose,
  onWroteRows,
}: {
  tableId: string
  tableName: string
  onClose: () => void
  // Called after a reply finishes, so the grid can reload rows the assistant
  // may have added/changed.
  onWroteRows?: () => void
}) {
  const { user } = useAuth()
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seen = useRef<Set<string>>(new Set())
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Find this table's existing thread (owner-only RLS → only mine). Don't create
  // one until the user actually sends, so opening a table doesn't litter the
  // chat list with empty threads.
  useEffect(() => {
    let active = true
    setConversationId(null)
    setMessages([])
    seen.current = new Set()
    supabase
      .from('conversations')
      .select('id')
      .eq('table_id', tableId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) setConversationId(data.id)
      })
    return () => {
      active = false
    }
  }, [tableId])

  // Load + subscribe to messages for the active conversation (mirrors ChatPage).
  useEffect(() => {
    if (!conversationId) return
    let active = true
    supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!active) return
        const rows = data ?? []
        rows.forEach((r) => seen.current.add(r.id))
        setMessages(rows)
      })
    const channel = supabase
      .channel(`table-chat:${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const row = payload.new as Message
          if (seen.current.has(row.id)) return
          seen.current.add(row.id)
          setMessages((prev) => [...prev, row])
        },
      )
      .subscribe()
    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [conversationId])

  // Auto-scroll to the newest content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming])

  const insertMessage = useCallback(
    async (convId: string, role: 'user' | 'assistant', content: string) => {
      const { data } = await supabase
        .from('messages')
        .insert({ conversation_id: convId, owner_id: user!.id, role, content })
        .select()
        .single()
      if (data) {
        seen.current.add(data.id)
        setMessages((prev) => [...prev, data])
      }
      return data
    },
    [user],
  )

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId
    const { data, error: insErr } = await supabase
      .from('conversations')
      .insert({ owner_id: user!.id, title: `Table: ${tableName}`.slice(0, 80), table_id: tableId })
      .select('id')
      .single()
    if (insErr || !data) throw insErr ?? new Error('Could not start the chat')
    setConversationId(data.id)
    return data.id
  }

  const doSend = useCallback(
    async (text: string) => {
      if (!text || sending || !user) return
      setInput('')
      setSending(true)
      setError(null)
      const history: ChatMessage[] = [
        ...messages.map((m) => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as ChatMessage['role'],
          content: m.content,
        })),
        { role: 'user', content: text },
      ]
      try {
        const convId = await ensureConversation()
        await insertMessage(convId, 'user', text)
        const controller = new AbortController()
        abortRef.current = controller
        setStreaming('')
        const full = await streamChat(history, (d) => setStreaming((s) => (s ?? '') + d), {
          tableId,
          signal: controller.signal,
        })
        setStreaming(null)
        if (full.trim()) await insertMessage(convId, 'assistant', full)
        await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId)
        onWroteRows?.()
      } catch (err) {
        setStreaming(null)
        if (!isAbortError(err)) setError(err instanceof Error ? err.message : 'Failed to send')
      } finally {
        abortRef.current = null
        setSending(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, sending, user, tableId, tableName],
  )

  function stop() {
    abortRef.current?.abort()
  }

  const empty = messages.length === 0 && !streaming
  const suggestions = ['Summarize this table', 'What stands out?', 'Add a row for…']

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface">
      {/* Friendly gradient header (design touch-up) */}
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary-strong text-white shadow-sm">
          <SparkleIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-text">Chat with table</h3>
          <p className="truncate text-xs text-faint">Ask about “{tableName}”</p>
        </div>
        <button
          onClick={onClose}
          title="Close chat"
          className="rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-text"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {empty && (
          <p className="mt-4 text-center text-sm text-muted">
            I can answer questions about this table, summarize it, or add and update rows for you. Try
            one of the suggestions below. Replies are saved here.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'assistant' ? 'flex justify-start' : 'flex justify-end'}>
            <div
              className={
                m.role === 'assistant'
                  ? 'max-w-[85%] rounded-2xl rounded-tl-sm bg-surface-2 px-3.5 py-2 text-sm text-text'
                  : 'max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2 text-sm text-white'
              }
            >
              {m.role === 'assistant' ? (
                <Markdown>{m.content}</Markdown>
              ) : (
                <span className="whitespace-pre-wrap">{m.content}</span>
              )}
            </div>
          </div>
        ))}
        {streaming !== null && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-surface-2 px-3.5 py-2 text-sm text-text">
              {streaming ? <Markdown>{streaming}</Markdown> : <span className="text-faint">…</span>}
            </div>
          </div>
        )}
      </div>

      {/* Suggested chips (design touch-up) — only before the first message. */}
      {empty && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => void doSend(s)}
              className="rounded-full border border-primary-soft-border bg-primary-soft/50 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary-soft"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <div className="border-t border-border bg-red-50 px-4 py-2 text-xs text-red-600">{error}</div>}

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void doSend(input.trim())
              }
            }}
            placeholder="Ask anything about this table…"
            rows={1}
            className="max-h-32 min-h-[40px] flex-1 resize-none rounded-xl border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
          {sending ? (
            <button
              onClick={stop}
              title="Stop"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted hover:text-text"
            >
              <StopIcon className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={() => void doSend(input.trim())}
              disabled={!input.trim()}
              title="Send"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition hover:bg-primary-strong disabled:opacity-40"
            >
              <SendIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
