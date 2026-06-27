import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { streamChat, type ChatAttachment, type ChatMessage } from '../lib/chat'
import { uploadPickedFile } from '../lib/upload'
import { useAuth } from '../contexts/AuthContext'
import { Markdown } from '../components/Markdown'
import {
  AgentIcon,
  ArtifactIcon,
  ChatIcon,
  CloseIcon,
  CollectionIcon,
  FileIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  SkillIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrashIcon,
} from '../components/icons'

type FeedbackRow = { rating: 'up' | 'down'; category: string | null; note: string | null }
type FeedbackPatch = { rating?: 'up' | 'down'; category?: string | null; note?: string | null }

const FEEDBACK_CATEGORIES = [
  { value: 'off_target', label: 'Off target' },
  { value: 'needs_work', label: 'Needs work' },
  { value: 'exactly_right', label: 'Exactly right' },
] as const

const BUCKET = 'files'

type Conversation = Database['public']['Tables']['conversations']['Row']
type Message = Database['public']['Tables']['messages']['Row']
type Skill = Database['public']['Tables']['skills']['Row']
type Agent = Database['public']['Tables']['agents']['Row']
type Collection = Database['public']['Tables']['collections']['Row']

export default function ChatPage() {
  const { conversationId } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [agent, setAgent] = useState<Agent | null>(null)

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showConvos, setShowConvos] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [showSkills, setShowSkills] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [feedback, setFeedback] = useState<Record<string, FeedbackRow>>({})
  const [collections, setCollections] = useState<Collection[]>([])
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [showCollections, setShowCollections] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
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

  // Delete a conversation (messages cascade via FK). If it's the open one, go home.
  async function deleteConversation(id: string, title: string) {
    if (!confirm(`Delete chat “${title}”? This can't be undone.`)) return
    await supabase.from('conversations').delete().eq('id', id)
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (id === conversationId) navigate('/chat')
  }

  // --- Load saved skills (for the slash menu / run button) ---
  useEffect(() => {
    supabase
      .from('skills')
      .select('*')
      .order('updated_at', { ascending: false })
      .then(({ data }) => setSkills(data ?? []))
  }, [])

  // --- Load collections (for scoping the chat to a focused set of artifacts) ---
  useEffect(() => {
    supabase
      .from('collections')
      .select('*')
      .order('name', { ascending: true })
      .then(({ data }) => setCollections(data ?? []))
  }, [])

  // --- Launched from Artifacts → "Chat with this" (?collection=id): preselect it ---
  const collectionParam = searchParams.get('collection')
  useEffect(() => {
    if (collectionParam) setCollectionId(collectionParam)
  }, [collectionParam])

  // --- If launched as an agent (?agent=id), load it and run chats with its prompt ---
  const agentId = searchParams.get('agent')
  useEffect(() => {
    if (!agentId) {
      setAgent(null)
      return
    }
    supabase
      .from('agents')
      .select('*')
      .eq('id', agentId)
      .maybeSingle()
      .then(({ data }) => setAgent(data))
  }, [agentId])

  // --- Launched from Agents → Run (?run=1): kick the agent off once. ---
  const autoRan = useRef(false)
  useEffect(() => {
    if (searchParams.get('run') === '1' && agent && !conversationId && !autoRan.current && !sending) {
      autoRan.current = true
      void submit('Run your task now — use your tools as needed, then give me the result.', [])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, conversationId, searchParams, sending])

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

  // --- Load this user's feedback for the conversation (one query) ---
  useEffect(() => {
    if (!conversationId || !user) {
      setFeedback({})
      return
    }
    let active = true
    supabase
      .from('message_feedback')
      .select('message_id, rating, category, note')
      .eq('conversation_id', conversationId)
      .eq('owner_id', user.id)
      .then(({ data }) => {
        if (!active) return
        const map: Record<string, FeedbackRow> = {}
        for (const r of data ?? []) {
          map[r.message_id] = { rating: r.rating, category: r.category, note: r.note }
        }
        setFeedback(map)
      })
    return () => {
      active = false
    }
  }, [conversationId, user])

  // Rate an assistant answer. Upserts (one verdict per user per message) and
  // snapshots what produced it (agent/source) so feedback can be attributed later.
  async function saveFeedback(messageId: string, patch: FeedbackPatch) {
    if (!user) return
    const existing = feedback[messageId]
    const next: FeedbackRow = {
      rating: patch.rating ?? existing?.rating ?? 'up',
      category: patch.category !== undefined ? patch.category : existing?.category ?? null,
      note: patch.note !== undefined ? patch.note : existing?.note ?? null,
    }
    setFeedback((prev) => ({ ...prev, [messageId]: next })) // optimistic
    const { error: fbErr } = await supabase.from('message_feedback').upsert(
      {
        message_id: messageId,
        conversation_id: conversationId ?? null,
        owner_id: user.id,
        rating: next.rating,
        category: next.category,
        note: next.note,
        agent_id: agent?.id ?? null,
        context: { source: agent ? 'agent' : 'chat', agent_name: agent?.name ?? null },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'message_id,owner_id' },
    )
    if (fbErr) setError(fbErr.message)
  }

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
    // Preserve the agent context across the navigation to the new conversation.
    navigate(`/chat/${data.id}${agentId ? `?agent=${agentId}` : ''}`)
    return data.id
  }

  async function insertMessage(
    convId: string,
    role: 'user' | 'assistant',
    content: string,
    atts?: ChatAttachment[],
  ) {
    const { data, error: insErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        owner_id: user!.id,
        role,
        content,
        attachments: (atts && atts.length ? atts : null) as never,
      })
      .select()
      .single()
    if (insErr || !data) throw insErr ?? new Error('Could not save message')
    seen.current.add(data.id)
    setMessages((prev) => [...prev, data])
    return data
  }

  // Upload a file to the Files area and queue it on the next message so the
  // assistant can read it.
  async function handleAttach(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !user) return
    setUploading(true)
    setError(null)
    try {
      const added: ChatAttachment[] = []
      for (const file of Array.from(fileList)) {
        const path = `${user.id}/${crypto.randomUUID()}/${file.name}`
        const size = await uploadPickedFile(path, file)
        await supabase.from('files').insert({
          owner_id: user.id,
          bucket: BUCKET,
          path,
          name: file.name,
          mime_type: file.type || null,
          size_bytes: size,
          visibility: 'private',
        })
        added.push({ path, name: file.name, mime: file.type || undefined })
      }
      setAttachments((prev) => [...prev, ...added])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      setError(
        /failed to fetch|networkerror|load failed/i.test(msg)
          ? 'Couldn’t upload that file — the request didn’t reach the server. If you picked it directly, try selecting it via Dropbox/Drive or download it to your device first.'
          : msg,
      )
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    // A leading "/" is a skill command, not a message — handled by the menu.
    if (text.startsWith('/')) return
    const atts = attachments
    if ((!text && atts.length === 0) || sending) return
    setInput('')
    setAttachments([])
    void submit(text, atts)
  }

  async function submit(text: string, atts: ChatAttachment[]) {
    if ((!text && atts.length === 0) || sending) return
    setSending(true)
    setError(null)

    try {
      const convId = await ensureConversation(text || atts[0]?.name || 'New chat')
      await insertMessage(convId, 'user', text, atts)

      // Build the history to send to the model. Attachments ride only on the
      // turn they're added (below) — we don't re-send historical files every
      // turn, which would re-upload and re-bill the whole document each message.
      const history: ChatMessage[] = [
        ...messages.map((m) => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as ChatMessage['role'],
          content: m.content,
        })),
        { role: 'user', content: text || '(see attached files)', attachments: atts },
      ]

      setStreaming('')
      const full = await streamChat(
        history,
        (delta) => setStreaming((s) => (s ?? '') + delta),
        // Running as an agent: layer its prompt onto the workspace context and
        // scope the assistant to the agent's chosen tools. A chosen collection
        // injects its artifacts as primary context.
        {
          ...(agent ? { system: agent.instructions, toolIds: agent.tool_ids } : {}),
          ...(collectionId ? { collectionId } : {}),
        },
      )
      setStreaming(null)
      const finalText = await materializeArtifacts(convId, full)
      await insertMessage(convId, 'assistant', finalText)
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

  // The assistant can emit :::artifact {json}\n...content...\n::: blocks.
  // Turn each into a saved artifact and replace the block with a share link.
  async function materializeArtifacts(convId: string, text: string): Promise<string> {
    const re = /:::artifact\s*(\{[\s\S]*?\})\s*\r?\n([\s\S]*?)\r?\n:::/g
    let out = ''
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      out += text.slice(last, m.index)
      last = re.lastIndex
      let attrs: { title?: string; type?: string } = {}
      try {
        attrs = JSON.parse(m[1])
      } catch {
        // malformed header — leave the block as-is
        out += m[0]
        continue
      }
      const type = (['markdown', 'code', 'html', 'text'].includes(attrs.type ?? '')
        ? attrs.type
        : 'markdown') as 'markdown' | 'code' | 'html' | 'text'
      const title = (attrs.title || 'Untitled artifact').slice(0, 120)
      const content = m[2].trim()
      const { data } = await supabase
        .from('artifacts')
        .insert({ owner_id: user!.id, conversation_id: convId, title, type, content, visibility: 'private' })
        .select()
        .single()
      out += data
        ? `✺ **${title}** — [open & share →](/artifacts/${data.id})`
        : `**${title}** (couldn’t save)`
    }
    out += text.slice(last)
    return out
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
        // Artifact skills fully control output (clean, no workspace chatter);
        // reply skills layer on top of the always-on context.
        { system: skill.instructions, replaceSystem: skill.output_mode === 'artifact' },
      )
      setStreaming(null)

      if (skill.output_mode === 'reply') {
        await insertMessage(convId, 'assistant', await materializeArtifacts(convId, full))
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

  // Only on-demand skills appear in the run menu (always-on prompts are applied
  // automatically by the server and never invoked here).
  const onDemandSkills = skills.filter((s) => !s.auto_apply)
  const slashQuery = input.startsWith('/') ? input.slice(1).toLowerCase() : null
  const skillMenuOpen = showSkills || slashQuery !== null
  const filteredSkills =
    slashQuery != null
      ? onDemandSkills.filter((s) => s.name.toLowerCase().includes(slashQuery))
      : onDemandSkills

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
        className={`absolute inset-y-0 left-0 z-20 flex w-64 flex-col border-r border-border bg-surface transition-transform md:static md:translate-x-0 ${
          showConvos ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-3">
          <button
            onClick={() => {
              navigate('/chat')
              setShowConvos(false)
            }}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text transition hover:bg-surface-hover"
          >
            <PlusIcon className="h-4 w-4" /> New chat
          </button>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded-lg transition ${
                c.id === conversationId ? 'bg-primary-soft' : 'hover:bg-surface-hover'
              }`}
            >
              <button
                onClick={() => {
                  navigate(`/chat/${c.id}`)
                  setShowConvos(false)
                }}
                className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-sm transition ${
                  c.id === conversationId ? 'text-primary' : 'text-muted'
                }`}
              >
                {c.title}
              </button>
              <button
                onClick={() => deleteConversation(c.id, c.title)}
                title="Delete chat"
                aria-label={`Delete chat ${c.title}`}
                className="mr-1 shrink-0 rounded-md p-1.5 text-faint opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-faint">
              No conversations yet
            </p>
          )}
        </div>
      </div>

      {/* Message panel */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile: open the conversation list */}
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 md:hidden">
          <button
            onClick={() => setShowConvos(true)}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted"
          >
            <ChatIcon className="h-4 w-4" /> Conversations
          </button>
          <button
            onClick={() => navigate('/chat')}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white"
          >
            <PlusIcon className="h-4 w-4" /> New
          </button>
        </div>
        {agent && (
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            <AgentIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 truncate font-medium">Agent: {agent.name}</span>
            <button onClick={() => navigate('/chat')} className="ml-auto text-xs underline hover:no-underline">
              Exit agent
            </button>
          </div>
        )}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-6">
            {messages.length === 0 && !streaming && (
              <div className="mt-24 flex flex-col items-center text-center">
                <div
                  className="mb-6 flex h-[74px] w-[74px] items-center justify-center rounded-[22px] bg-gradient-to-br from-primary to-primary-strong text-4xl text-white"
                  style={{ boxShadow: '0 12px 34px rgba(99,84,232,.40)' }}
                >
                  ✺
                </div>
                <h2 className="text-[34px] font-extrabold tracking-tight text-text">
                  What do you want to build?
                </h2>
                <p className="mt-3 max-w-md text-[17px] leading-relaxed text-muted">
                  Paste context, ask anything, or type{' '}
                  <code className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-sm text-text">/</code> to run a saved
                  skill.
                </p>
              </div>
            )}

            <div className="space-y-5">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  role={m.role}
                  content={m.content}
                  attachments={(m.attachments as ChatAttachment[] | null) ?? undefined}
                  onSaveArtifact={
                    m.role === 'assistant' ? () => saveAsArtifact(m.content) : undefined
                  }
                  feedback={m.role === 'assistant' ? feedback[m.id] : undefined}
                  onFeedback={
                    m.role === 'assistant' ? (patch) => saveFeedback(m.id, patch) : undefined
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

        <form onSubmit={handleSend} className="border-t border-border bg-surface p-4">
          <div className="relative mx-auto max-w-3xl">
            {/* Skill menu (slash command or the ⚡ button) */}
            {skillMenuOpen && (
              <div className="absolute bottom-full mb-2 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-surface shadow-lg">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Run a skill
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate('/skills')}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Manage
                  </button>
                </div>
                {filteredSkills.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-faint">
                    {onDemandSkills.length === 0 ? 'No skills yet — create one' : 'No match'}
                  </p>
                ) : (
                  filteredSkills.map((s) => (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => runSkill(s)}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-hover"
                    >
                      <SkillIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text">
                          {s.name}
                          <span className="ml-2 text-[11px] font-normal text-faint">
                            {s.output_mode === 'artifact' ? `→ ${s.artifact_type} artifact` : '→ reply'}
                          </span>
                        </span>
                        {s.description && (
                          <span className="block truncate text-xs text-muted">{s.description}</span>
                        )}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {/* Collection picker menu */}
            {showCollections && (
              <div className="absolute bottom-full mb-2 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-surface shadow-lg">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Chat with a collection
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate('/artifacts')}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Manage
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setCollectionId(null)
                    setShowCollections(false)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover ${
                    collectionId === null ? 'text-primary' : 'text-muted'
                  }`}
                >
                  No collection (whole workspace)
                </button>
                {collections.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-faint">
                    No collections yet — group artifacts on the Artifacts page.
                  </p>
                ) : (
                  collections.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => {
                        setCollectionId(c.id)
                        setShowCollections(false)
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover ${
                        collectionId === c.id ? 'text-primary' : 'text-text'
                      }`}
                    >
                      <CollectionIcon className="h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      {c.visibility === 'workspace' && (
                        <span className="text-[10px] uppercase tracking-wide text-faint">shared</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}

            {/* Active collection scope */}
            {collectionId && (
              <div className="mb-2 flex flex-wrap gap-2">
                <span className="flex items-center gap-1.5 rounded-lg border border-brand-300 bg-primary-soft px-2 py-1 text-xs font-medium text-primary">
                  <CollectionIcon className="h-3.5 w-3.5" />
                  <span className="max-w-[200px] truncate">
                    {collections.find((c) => c.id === collectionId)?.name ?? 'Collection'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCollectionId(null)}
                    title="Remove collection scope"
                    className="text-primary hover:text-primary-strong"
                  >
                    <CloseIcon className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            )}

            {/* Pending file attachments */}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <span
                    key={a.path}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs text-muted"
                  >
                    <FileIcon className="h-3.5 w-3.5 text-faint" />
                    <span className="max-w-[160px] truncate">{a.name}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      className="text-faint hover:text-red-600"
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowSkills((v) => !v)
                  setShowCollections(false)
                }}
                title="Run a skill"
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition ${
                  skillMenuOpen
                    ? 'border-brand-300 bg-primary-soft text-primary'
                    : 'border-border-strong text-muted hover:bg-surface-hover'
                }`}
              >
                <SkillIcon className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCollections((v) => !v)
                  setShowSkills(false)
                }}
                title="Chat with a collection"
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition ${
                  showCollections || collectionId
                    ? 'border-brand-300 bg-primary-soft text-primary'
                    : 'border-border-strong text-muted hover:bg-surface-hover'
                }`}
              >
                <CollectionIcon className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                title="Attach a file"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border-strong text-muted transition hover:bg-surface-hover disabled:opacity-50"
              >
                <PaperclipIcon className="h-5 w-5" />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => handleAttach(e.target.files)}
              />
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
                className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border border-border-strong px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
              />
              <button
                type="submit"
                disabled={
                  sending ||
                  uploading ||
                  (!input.trim() && attachments.length === 0) ||
                  input.startsWith('/')
                }
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition hover:bg-primary-strong disabled:opacity-50"
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
  attachments,
  onSaveArtifact,
  feedback,
  onFeedback,
}: {
  role: string
  content: string
  streaming?: boolean
  attachments?: ChatAttachment[]
  onSaveArtifact?: () => void
  feedback?: FeedbackRow
  onFeedback?: (patch: FeedbackPatch) => void
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
              ? 'bg-primary text-white'
              : 'border border-border bg-surface text-text'
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
          {attachments && attachments.length > 0 && (
            <div className={`mt-2 flex flex-wrap gap-1.5 ${isUser ? 'justify-end' : ''}`}>
              {attachments.map((a) => (
                <span
                  key={a.path}
                  className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${
                    isUser ? 'bg-brand-500/40 text-white' : 'bg-surface-2 text-muted'
                  }`}
                >
                  <FileIcon className="h-3 w-3" />
                  <span className="max-w-[140px] truncate">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {streaming && <span className="ml-0.5 inline-block animate-pulse">▋</span>}
        </div>
        {!streaming && (onSaveArtifact || onFeedback) && (
          <div className="mt-1 space-y-1">
            {onSaveArtifact && (
              <button
                onClick={onSaveArtifact}
                className="flex items-center gap-1 text-xs text-faint opacity-0 transition group-hover:opacity-100 hover:text-primary"
              >
                <ArtifactIcon className="h-3.5 w-3.5" /> Save as artifact
              </button>
            )}
            {onFeedback && <MessageFeedback feedback={feedback} onFeedback={onFeedback} />}
          </div>
        )}
      </div>
    </div>
  )
}

// Thumbs up/down + optional category and note on an assistant answer. Writes
// through onFeedback (an upsert), so re-rating just overwrites.
function MessageFeedback({
  feedback,
  onFeedback,
}: {
  feedback?: FeedbackRow
  onFeedback: (patch: FeedbackPatch) => void
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState(feedback?.note ?? '')
  const rated = feedback?.rating

  return (
    <div>
      <div
        className={`flex items-center gap-1 text-faint transition ${
          rated ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <button
          title="Good answer"
          onClick={() => {
            onFeedback({ rating: 'up' })
            setOpen(true)
          }}
          className={`rounded-md p-1 transition hover:text-primary ${
            rated === 'up' ? 'text-primary' : ''
          }`}
        >
          <ThumbsUpIcon className="h-3.5 w-3.5" />
        </button>
        <button
          title="Needs work"
          onClick={() => {
            onFeedback({ rating: 'down' })
            setOpen(true)
          }}
          className={`rounded-md p-1 transition hover:text-red-600 ${
            rated === 'down' ? 'text-red-600' : ''
          }`}
        >
          <ThumbsDownIcon className="h-3.5 w-3.5" />
        </button>
        {rated && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="ml-1 text-[11px] transition hover:text-text"
          >
            {open ? 'Close' : 'Add detail'}
          </button>
        )}
      </div>

      {open && rated && (
        <div className="mt-1.5 w-full max-w-sm rounded-lg border border-border bg-surface p-2">
          <div className="flex flex-wrap gap-1">
            {FEEDBACK_CATEGORIES.map((c) => (
              <button
                key={c.value}
                onClick={() =>
                  onFeedback({ category: feedback?.category === c.value ? null : c.value })
                }
                className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                  feedback?.category === c.value
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-muted hover:bg-surface-hover'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              if (note !== (feedback?.note ?? '')) onFeedback({ note: note || null })
            }}
            rows={2}
            placeholder="What was off, or what was great? (optional)"
            className="mt-2 w-full resize-none rounded-md border border-border-strong px-2 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary-soft"
          />
        </div>
      )}
    </div>
  )
}
