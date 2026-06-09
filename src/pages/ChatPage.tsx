import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { streamChat, type ChatMessage } from '../lib/chat'
import { useAuth } from '../contexts/AuthContext'
import { Markdown } from '../components/Markdown'
import { ArtifactIcon, ChatIcon, PlusIcon, SendIcon, SkillIcon } from '../components/icons'

type Conversation = Database['public']['Tables']['conversations']['Row']
type Message = Database['public']['Tables']['messages']['Row']
type Skill = Database['public']['Tables']['skills']['Row']

export default function ChatPage() {
  const { conversationId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showConvos, setShowConvos] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [showSkills, setShowSkills] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const seen = useRef<Set<string>>(new Set())

  // --- Load conversation list ---
  const loadConversations = useCallback(async () => {
    const { data } = await supabase
      .from('conversations')
      .select('*')
      .order('updated_at', { ascending: false })
    setConversations(data ?? [])
  }, [])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  // --- Load saved skills (for the slash menu / run button) ---
  useEffect(() => {
    supabase
      .from('skills')
      .select('*')
      .order('updated_at', { ascending: false })
      .then(({ data }) => setSkills(data ?? []))
  }, [])

  // --- Load + subscribe to messages for the active conversation ---
  useEffect(() => {
    seen.current = new Set()
    setMessages([])
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
      .channel(`messages:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
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

  // --- Auto-scroll to bottom on new content ---
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, streaming])

  async function ensureConversation(firstMessage: string): Promise<string> {
    if (conversationId) return conversationId
    const title = firstMessage.slice(0, 48) || 'New chat'
    const { data, error: insErr } = await supabase
      .from('conversations')
      .insert({ owner_id: user!.id, title })
      .select()
      .single()
    if (insErr || !data) throw insErr ?? new Error('Could not create conversation')
    await loadConversations()
    navigate(`/chat/${data.id}`)
    return data.id
  }

  async function insertMessage(
    convId: string,
    role: 'user' | 'assistant',
    content: string,
  ) {
    const { data, error: insErr } = await supabase
      .from('messages')
      .insert({ conversation_id: convId, owner_id: user!.id, role, content })
      .select()
      .single()
    if (insErr || !data) throw insErr ?? new Error('Could not save message')
    seen.current.add(data.id)
    setMessages((prev) => [...prev, data])
    return data
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || sending) return
    // A leading "/" is a skill command, not a message — handled by the menu.
    if (text.startsWith('/')) return

    setSending(true)
    setError(null)
    setInput('')

    try {
      const convId = await ensureConversation(text)
      await insertMessage(convId, 'user', text)

      // Build the history to send to the model (current state + the new turn).
      const history: ChatMessage[] = [
        ...messages.map((m) => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as ChatMessage['role'],
          content: m.content,
        })),
        { role: 'user', content: text },
      ]

      setStreaming('')
      const full = await streamChat(history, (delta) =>
        setStreaming((s) => (s ?? '') + delta),
      )
      setStreaming(null)
      await insertMessage(convId, 'assistant', full)
      // Touch conversation so it floats to the top of the list.
      await supabase
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', convId)
      loadConversations()
    } catch (err) {
      setStreaming(null)
      setError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  async function saveAsArtifact(content: string) {
    const { data, error: insErr } = await supabase
      .from('artifacts')
      .insert({
        owner_id: user!.id,
        conversation_id: conversationId ?? null,
        title: 'Untitled artifact',
        type: 'markdown',
        content,
        visibility: 'private',
      })
      .select()
      .single()
    if (insErr || !data) {
      setError(insErr?.message ?? 'Could not create artifact')
      return
    }
    navigate(`/artifacts/${data.id}`)
  }

  // Run a saved skill against the current conversation context.
  async function runSkill(skill: Skill) {
    if (sending) return
    setShowSkills(false)
    setError(null)

    const pending = input.trim()
    // Context = everything already in the conversation, plus any unsent text.
    const history: ChatMessage[] = messages.map((m) => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as ChatMessage['role'],
      content: m.content,
    }))
    if (pending) history.push({ role: 'user', content: pending })

    if (history.length === 0) {
      setError('Add some context to the chat first, then run a skill.')
      return
    }

    setSending(true)
    setInput('')
    try {
      const convId = await ensureConversation(pending || skill.name)
      if (pending) await insertMessage(convId, 'user', pending)
      await insertMessage(convId, 'user', `▶ Ran skill: ${skill.name}`)

      // The skill's instructions become the system prompt; a final nudge gives
      // the model a turn to respond to.
      const modelHistory: ChatMessage[] = [
        ...history,
        { role: 'user', content: 'Run the skill on the context above and produce the final output now.' },
      ]

      setStreaming('')
      const full = await streamChat(
        modelHistory,
        (delta) => setStreaming((s) => (s ?? '') + delta),
        { system: skill.instructions },
      )
      setStreaming(null)

      if (skill.output_mode === 'reply') {
        await insertMessage(convId, 'assistant', full)
      } else {
        const { data: art } = await supabase
          .from('artifacts')
          .insert({
            owner_id: user!.id,
            conversation_id: convId,
            title: skill.name,
            type: skill.artifact_type,
            content: full,
            visibility: 'private',
          })
          .select()
          .single()
        const link = art
          ? `✺ Created artifact **${skill.name}** — [open & share →](/artifacts/${art.id})`
          : 'Created artifact.'
        await insertMessage(convId, 'assistant', link)
      }

      await supabase
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', convId)
      loadConversations()
    } catch (err) {
      setStreaming(null)
      setError(err instanceof Error ? err.message : 'Skill failed')
    } finally {
      setSending(false)
    }
  }

  // Skill menu state derived from the composer (slash command) or the button.
  const slashQuery = input.startsWith('/') ? input.slice(1).toLowerCase() : null
  const skillMenuOpen = showSkills || slashQuery !== null
  const filteredSkills =
    slashQuery != null
      ? skills.filter((s) => s.name.toLowerCase().includes(slashQuery))
      : skills

  return (
    <div className="relative flex h-full">
      {/* Conversation list — static sidebar on md+, slide-over on mobile */}
      {showConvos && (
        <div
          className="absolute inset-0 z-10 bg-slate-900/30 md:hidden"
          onClick={() => setShowConvos(false)}
        />
      )}
      <div
        className={`absolute inset-y-0 left-0 z-20 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform md:static md:translate-x-0 ${
          showConvos ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-3">
          <button
            onClick={() => {
              navigate('/chat')
              setShowConvos(false)
            }}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <PlusIcon className="h-4 w-4" /> New chat
          </button>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                navigate(`/chat/${c.id}`)
                setShowConvos(false)
              }}
              className={`block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition ${
                c.id === conversationId
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {c.title}
            </button>
          ))}
          {conversations.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-slate-400">
              No conversations yet
            </p>
          )}
        </div>
      </div>

      {/* Message panel */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile: open the conversation list */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 md:hidden">
          <button
            onClick={() => setShowConvos(true)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600"
          >
            <ChatIcon className="h-4 w-4" /> Conversations
          </button>
          <button
            onClick={() => navigate('/chat')}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white"
          >
            <PlusIcon className="h-4 w-4" /> New
          </button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
            {messages.length === 0 && !streaming && (
              <div className="mt-20 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-2xl text-white">
                  ✺
                </div>
                <h2 className="text-lg font-semibold text-slate-800">
                  What do you want to build?
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Paste context, ask anything, or type <code className="rounded bg-slate-100 px-1">/</code> to run a saved skill.
                </p>
              </div>
            )}

            <div className="space-y-5">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  role={m.role}
                  content={m.content}
                  onSaveArtifact={
                    m.role === 'assistant' ? () => saveAsArtifact(m.content) : undefined
                  }
                />
              ))}
              {streaming !== null && (
                <MessageBubble role="assistant" content={streaming || '…'} streaming />
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="mx-auto w-full max-w-3xl px-4">
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          </div>
        )}

        <form onSubmit={handleSend} className="border-t border-slate-200 bg-white p-4">
          <div className="relative mx-auto max-w-3xl">
            {/* Skill menu (slash command or the ⚡ button) */}
            {skillMenuOpen && (
              <div className="absolute bottom-full mb-2 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Run a skill
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate('/skills')}
                    className="text-xs font-medium text-brand-600 hover:underline"
                  >
                    Manage
                  </button>
                </div>
                {filteredSkills.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-slate-400">
                    {skills.length === 0 ? 'No skills yet — create one' : 'No match'}
                  </p>
                ) : (
                  filteredSkills.map((s) => (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => runSkill(s)}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-50"
                    >
                      <SkillIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-800">
                          {s.name}
                          <span className="ml-2 text-[11px] font-normal text-slate-400">
                            {s.output_mode === 'artifact' ? `→ ${s.artifact_type} artifact` : '→ reply'}
                          </span>
                        </span>
                        {s.description && (
                          <span className="block truncate text-xs text-slate-500">{s.description}</span>
                        )}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => setShowSkills((v) => !v)}
                title="Run a skill"
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition ${
                  skillMenuOpen
                    ? 'border-brand-300 bg-brand-50 text-brand-600'
                    : 'border-slate-300 text-slate-500 hover:bg-slate-50'
                }`}
              >
                <SkillIcon className="h-5 w-5" />
              </button>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (skillMenuOpen && filteredSkills.length > 0) {
                      runSkill(filteredSkills[0])
                    } else {
                      handleSend(e)
                    }
                  }
                }}
                rows={1}
                placeholder="Message the assistant…  (type / to run a skill)"
                className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
              <button
                type="submit"
                disabled={sending || !input.trim() || input.startsWith('/')}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-50"
              >
                <SendIcon className="h-5 w-5" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

function MessageBubble({
  role,
  content,
  streaming,
  onSaveArtifact,
}: {
  role: string
  content: string
  streaming?: boolean
  onSaveArtifact?: () => void
}) {
  const isUser = role === 'user'
  // Long pasted context collapses so it doesn't dominate the thread.
  const isLong = isUser && content.length > 600
  const [expanded, setExpanded] = useState(false)
  const shown = isLong && !expanded ? content.slice(0, 500) : content
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`group max-w-[85%] ${isUser ? 'order-2' : ''}`}>
        <div
          className={`rounded-2xl px-4 py-2.5 ${
            isUser
              ? 'bg-brand-600 text-white'
              : 'border border-slate-200 bg-white text-slate-800'
          }`}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
              {shown}
              {isLong && !expanded && '…'}
              {isLong && (
                <button
                  onClick={() => setExpanded((v) => !v)}
                  className="ml-1 font-medium text-brand-100 underline underline-offset-2"
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </p>
          ) : (
            <Markdown>{content}</Markdown>
          )}
          {streaming && <span className="ml-0.5 inline-block animate-pulse">▋</span>}
        </div>
        {onSaveArtifact && !streaming && (
          <button
            onClick={onSaveArtifact}
            className="mt-1 flex items-center gap-1 text-xs text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-brand-600"
          >
            <ArtifactIcon className="h-3.5 w-3.5" /> Save as artifact
          </button>
        )}
      </div>
    </div>
  )
}
