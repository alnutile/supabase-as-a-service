import { useCallback, useEffect, useRef, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { streamChat, type ChatMessage } from '../lib/chat'
import { isAbortError } from '../lib/chatError'
import { Markdown } from './Markdown'
import { CloseIcon, SendIcon, StopIcon } from './icons'

type Message = Database['public']['Tables']['messages']['Row']

// A persistent chat panel scoped to one card board. Unlike the ephemeral
// CollectionsPage bubble, it's backed by a real conversation (found-or-created
// for this owner+board) in the same conversations/messages tables the main Chat
// uses — so history survives, syncs over realtime, and appears in the chat list.
// The board's cards are injected as context via streamChat({ cardBoardId }); the
// assistant can add cards back (add_cards) and the canvas re-renders live.
export function BoardChatPanel({
  boardId,
  boardTitle,
  onClose,
}: {
  boardId: string
  boardTitle: string
  onClose: () => void
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

  // Find this board's existing thread (owner-only RLS → only mine). Don't create
  // one until the user actually sends, so opening a board doesn't litter the chat
  // list with empty threads.
  useEffect(() => {
    let active = true
    setConversationId(null)
    setMessages([])
    seen.current = new Set()
    supabase
      .from('conversations')
      .select('id')
      .eq('card_board_id', boardId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) setConversationId(data.id)
      })
    return () => {
      active = false
    }
  }, [boardId])

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
      .channel(`board-chat:${conversationId}`)
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
      .insert({ owner_id: user!.id, title: `Cards: ${boardTitle}`.slice(0, 80), card_board_id: boardId })
      .select('id')
      .single()
    if (insErr || !data) throw insErr ?? new Error('Could not start the chat')
    setConversationId(data.id)
    return data.id
  }

  async function send() {
    const text = input.trim()
    if (!text || sending || !user) return
    setInput('')
    setSending(true)
    setError(null)
    // History from what's on screen now + this turn (built before the insert).
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
        cardBoardId: boardId,
        signal: controller.signal,
      })
      setStreaming(null)
      if (full.trim()) await insertMessage(convId, 'assistant', full)
      await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId)
    } catch (err) {
      setStreaming(null)
      if (!isAbortError(err)) setError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      abortRef.current = null
      setSending(false)
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col border-l border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-text">Chat</h3>
          <p className="truncate text-xs text-faint">about “{boardTitle}”</p>
        </div>
        <button onClick={onClose} title="Close chat" className="rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-text">
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !streaming && (
          <p className="mt-6 text-center text-sm text-muted">
            Ask about these cards, or say “add cards for …”, “what should I prioritise?”. Replies are saved here.
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

      {error && <div className="border-t border-border bg-red-50 px-4 py-2 text-xs text-red-600">{error}</div>}

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={`Message “${boardTitle}”…`}
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
              onClick={() => void send()}
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
