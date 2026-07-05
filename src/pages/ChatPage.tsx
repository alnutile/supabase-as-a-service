import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Database, Json } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { streamChat, type ChatAttachment, type ChatMessage } from '../lib/chat'
import { ArtifactFrame } from '../components/ArtifactFrame'
import { parseArtifactBlocks } from '../lib/artifacts'
import { ResizeHandle, usePanelResize } from '../components/ResizeHandle'
import { uploadPickedFile } from '../lib/upload'
import { estimateTokensFromChars } from '../lib/tokens'
import { useOrchestratorContext } from '../lib/useModelContext'
import { ContextUsage } from '../components/ContextMeter'
import { useAuth } from '../contexts/AuthContext'
import { Markdown } from '../components/Markdown'
import {
  AgentIcon,
  ArtifactIcon,
  ChatIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CollectionIcon,
  FileIcon,
  PaperclipIcon,
  PinIcon,
  PlusIcon,
  SendIcon,
  SkillIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrashIcon,
  UsersIcon,
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
type Artifact = Database['public']['Tables']['artifacts']['Row']
type Skill = Database['public']['Tables']['skills']['Row']
type Agent = Database['public']['Tables']['agents']['Row']
type Collection = Database['public']['Tables']['collections']['Row']
type WorkspaceMember = { id: string; email: string | null; display_name: string | null }

// "@ai" anywhere in a message summons the assistant in a shared thread.
const AI_MENTION = /(^|\s)@ai\b/i

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
  // Collapse the conversation column (md+) to reclaim space. Persisted so the
  // choice sticks across sessions/reloads.
  const [convosCollapsed, setConvosCollapsed] = useState(
    () => localStorage.getItem('chat-convos-collapsed') === '1',
  )
  useEffect(() => {
    localStorage.setItem('chat-convos-collapsed', convosCollapsed ? '1' : '0')
  }, [convosCollapsed])
  const [skills, setSkills] = useState<Skill[]>([])
  const [showSkills, setShowSkills] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [feedback, setFeedback] = useState<Record<string, FeedbackRow>>({})
  const [collections, setCollections] = useState<Collection[]>([])
  const [collectionTokens, setCollectionTokens] = useState<Record<string, number>>({})
  const [collectionIds, setCollectionIds] = useState<string[]>([])
  const [combinedTokens, setCombinedTokens] = useState(0)
  const [showCollections, setShowCollections] = useState(false)
  const [directory, setDirectory] = useState<WorkspaceMember[]>([])
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [showMembers, setShowMembers] = useState(false)
  // The live artifact panel: a tracker/doc rendered beside the thread that
  // updates in realtime and (for html) persists clicks via ArtifactFrame.
  const [panelArtifact, setPanelArtifact] = useState<Artifact | null>(null)
  const panelResize = usePanelResize('chat-artifact-panel-w', 480)
  const model = useOrchestratorContext()

  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const seen = useRef<Set<string>>(new Set())

  // --- Load conversation list (pinned first, then most-recent) ---
  const loadConversations = useCallback(async () => {
    const { data } = await supabase
      .from('conversations')
      .select('*')
      .order('pinned', { ascending: false })
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

  // Pin / unpin a conversation so it floats to the top of the list. Optimistic,
  // then re-sort (pinned first, then recency) by reloading.
  async function togglePin(id: string, pinned: boolean) {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, pinned } : c)))
    await supabase.from('conversations').update({ pinned }).eq('id', id)
    loadConversations()
  }

  // --- Workspace member directory (for the "add people" picker + name labels) ---
  useEffect(() => {
    supabase
      .rpc('list_workspace_members')
      .then(({ data }) => setDirectory((data as WorkspaceMember[] | null) ?? []))
  }, [])

  // --- Members of the open thread (live — others may add people mid-chat) ---
  useEffect(() => {
    setMemberIds([])
    setShowMembers(false)
    if (!conversationId) return
    const loadMembers = () =>
      supabase
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', conversationId)
        .then(({ data }) => setMemberIds((data ?? []).map((r) => r.user_id)))
    loadMembers()
    const channel = supabase
      .channel(`members:${conversationId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversation_members', filter: `conversation_id=eq.${conversationId}` },
        () => loadMembers(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [conversationId])

  // --- Live artifact panel ---
  const openArtifactPanel = useCallback(async (id: string) => {
    const { data } = await supabase.from('artifacts').select('*').eq('id', id).maybeSingle()
    if (data) setPanelArtifact(data)
  }, [])

  // Follow the open artifact over Realtime so the panel refreshes live when
  // the assistant (update_artifact), another device, or a teammate changes it.
  useEffect(() => {
    const id = panelArtifact?.id
    if (!id) return
    const channel = supabase
      .channel(`artifact:${id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'artifacts', filter: `id=eq.${id}` },
        (payload) =>
          setPanelArtifact((a) => (a && a.id === id ? { ...a, ...(payload.new as Artifact) } : a)),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
    // Only re-subscribe when the OPEN ARTIFACT changes, not on every row update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelArtifact?.id])

  // Interactive-state saves from the panel iframe. Update local state too so
  // the realtime echo of our own write is a no-op in ArtifactFrame.
  const savePanelData = useCallback(
    async (data: Json) => {
      const id = panelArtifact?.id
      if (!id) return
      setPanelArtifact((a) => (a && a.id === id ? { ...a, data } : a))
      await supabase.from('artifacts').update({ data }).eq('id', id)
    },
    [panelArtifact?.id],
  )

  // Launched from the artifact editor's "Chat" button (?artifact=id): open it
  // in the live panel so the conversation is *about* that artifact from turn
  // one (submit() tells the model which artifact is on screen).
  const artifactParam = searchParams.get('artifact')
  useEffect(() => {
    if (artifactParam) void openArtifactPanel(artifactParam)
  }, [artifactParam, openArtifactPanel])

  const convo = useMemo(
    () => conversations.find((c) => c.id === conversationId) ?? null,
    [conversations, conversationId],
  )
  // Everyone in the thread: explicit members + the owner (implicit).
  const participantIds = useMemo(() => {
    const set = new Set<string>(memberIds)
    if (convo) set.add(convo.owner_id)
    return set
  }, [memberIds, convo])
  // A thread with 2+ humans is a group chat: the AI only replies on @ai.
  const isGroup = participantIds.size > 1

  // Real name for the model's history; the UI variant says "You" for yourself.
  const realNameOf = useCallback(
    (id: string) => {
      const m = directory.find((d) => d.id === id)
      return m?.display_name || m?.email?.split('@')[0] || 'Member'
    },
    [directory],
  )
  const nameOf = useCallback(
    (id: string) => (id === user?.id ? 'You' : realNameOf(id)),
    [realNameOf, user],
  )

  async function toggleMember(memberId: string) {
    if (!conversationId || !user) return
    if (memberIds.includes(memberId)) {
      await supabase
        .from('conversation_members')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('user_id', memberId)
      setMemberIds((prev) => prev.filter((id) => id !== memberId))
    } else {
      await supabase.from('conversation_members').insert({
        conversation_id: conversationId,
        user_id: memberId,
        added_by: user.id,
      })
      setMemberIds((prev) => [...prev, memberId])
    }
  }

  // --- Load saved skills (for the slash menu / run button) ---
  useEffect(() => {
    supabase
      .from('skills')
      .select('*')
      .order('updated_at', { ascending: false })
      .then(({ data }) => setSkills(data ?? []))
  }, [])

  // --- Load collections + their estimated size (for scoping the chat) ---
  useEffect(() => {
    let active = true
    async function run() {
      const [cRes, sRes] = await Promise.all([
        supabase.from('collections').select('*').order('name', { ascending: true }),
        supabase.rpc('collection_token_stats'),
      ])
      if (!active) return
      setCollections(cRes.data ?? [])
      const tok: Record<string, number> = {}
      for (const s of sRes.data ?? []) tok[s.collection_id] = estimateTokensFromChars(Number(s.char_total))
      setCollectionTokens(tok)
    }
    run()
    return () => {
      active = false
    }
  }, [])

  // --- Launched from Artifacts → "Chat with this" (?collection=id, or
  //     ?collections=a,b for several): preselect them ---
  const collectionParam = searchParams.get('collection')
  const collectionsParam = searchParams.get('collections')
  useEffect(() => {
    const ids = collectionsParam
      ? collectionsParam.split(',').map((s) => s.trim()).filter(Boolean)
      : collectionParam
        ? [collectionParam]
        : []
    if (ids.length) setCollectionIds(ids)
  }, [collectionParam, collectionsParam])

  // --- Combined deduped size of the scoped collections (for the context meter) ---
  useEffect(() => {
    if (collectionIds.length === 0) {
      setCombinedTokens(0)
      return
    }
    let active = true
    supabase.rpc('collections_combined_chars', { p_ids: collectionIds }).then(({ data, error }) => {
      if (!active) return
      if (error || data == null) {
        // Pre-migration fallback: sum per-collection sizes (may double-count overlap).
        setCombinedTokens(collectionIds.reduce((sum, id) => sum + (collectionTokens[id] ?? 0), 0))
      } else {
        setCombinedTokens(estimateTokensFromChars(Number(data)))
      }
    })
    return () => {
      active = false
    }
  }, [collectionIds, collectionTokens])

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

      // In a shared thread, humans talk to each other — the assistant only
      // pipes in when someone writes @ai. Solo threads keep the classic
      // always-reply behavior.
      if (isGroup && !AI_MENTION.test(text)) {
        await supabase
          .from('conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', convId)
        loadConversations()
        return
      }

      // Build the history to send to the model. Attachments ride only on the
      // turn they're added (below) — we don't re-send historical files every
      // turn, which would re-upload and re-bill the whole document each message.
      // In a group thread each human message is prefixed with its sender so the
      // model can follow who said what.
      const label = (id: string) => (isGroup ? `${realNameOf(id)}: ` : '')
      const history: ChatMessage[] = [
        ...messages.map((m) => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as ChatMessage['role'],
          content: m.role === 'assistant' ? m.content : `${label(m.owner_id)}${m.content}`,
        })),
        {
          role: 'user',
          content: `${user ? label(user.id) : ''}${text || '(see attached files)'}`,
          attachments: atts,
        },
      ]

      setStreaming('')
      const full = await streamChat(
        history,
        (delta) => setStreaming((s) => (s ?? '') + delta),
        // Running as an agent: layer its prompt onto the workspace context and
        // scope the assistant to the agent's chosen tools. The chat is scoped to
        // the user-picked collections PLUS any the agent is bound to.
        (() => {
          const merged = [...new Set([...collectionIds, ...(agent?.collection_ids ?? [])])]
          const groupNote = isGroup
            ? 'This is a group thread between several human teammates; each human message is prefixed with the sender\'s name. You were summoned with @ai — answer the thread, addressing people by name when useful.'
            : ''
          // The open panel is shared context: "make it wider / check off X /
          // add a row" should edit THAT artifact, not mint a new one.
          const artifactNote = panelArtifact
            ? `The user has the artifact "${panelArtifact.title}" (id ${panelArtifact.id}, type ${panelArtifact.type}) open in a live panel beside this chat. When they ask you to change, update, or add to "it" (the artifact/tracker/doc), call get_artifact with that id to read the current version, then update_artifact with the complete new content — do NOT create a new artifact or emit a :::artifact block for a revision. The panel updates live when you save.`
            : ''
          const system = [agent?.instructions, groupNote, artifactNote].filter(Boolean).join('\n\n')
          return {
            ...(system ? { system } : {}),
            ...(agent ? { toolIds: agent.tool_ids } : {}),
            ...(merged.length ? { collectionIds: merged } : {}),
          }
        })(),
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
  // Turn each into a saved artifact and replace the block with a share link
  // (parsing lives in src/lib/artifacts.ts so the format is unit-tested).
  async function materializeArtifacts(convId: string, text: string): Promise<string> {
    let out = ''
    for (const chunk of parseArtifactBlocks(text)) {
      if (chunk.kind === 'text') {
        out += chunk.text
        continue
      }
      const { title, type, content } = chunk
      const { data } = await supabase
        .from('artifacts')
        .insert({ owner_id: user!.id, conversation_id: convId, title, type, content, visibility: 'private' })
        .select()
        .single()
      // Show the new artifact live beside the thread right away (last one
      // wins if a reply creates several).
      if (data) setPanelArtifact(data)
      out += data
        ? `✺ **${title}** — [open & share →](/artifacts/${data.id})`
        : `**${title}** (couldn’t save)`
    }
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
        if (art) setPanelArtifact(art)
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
      {/* Collapsed rail (md+ only): a thin strip that reclaims horizontal space
          with just expand + new-chat. Collapsing is a desktop affordance — on
          mobile the list is already a slide-over. */}
      {convosCollapsed && (
        <div className="hidden md:flex w-12 shrink-0 flex-col items-center gap-2 border-r border-border bg-surface py-3">
          <button
            onClick={() => setConvosCollapsed(false)}
            title="Expand conversations"
            aria-label="Expand conversations"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted transition hover:bg-surface-hover"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              setPanelArtifact(null)
              navigate('/chat')
            }}
            title="New chat"
            aria-label="New chat"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-text transition hover:bg-surface-hover"
          >
            <PlusIcon className="h-4 w-4" />
          </button>
        </div>
      )}
      <div
        className={`absolute inset-y-0 left-0 z-20 flex w-64 flex-col border-r border-border bg-surface transition-transform md:static md:translate-x-0 ${
          showConvos ? 'translate-x-0' : '-translate-x-full'
        } ${convosCollapsed ? 'md:hidden' : ''}`}
      >
        <div className="flex items-center gap-2 p-3">
          <button
            onClick={() => {
              setPanelArtifact(null)
              navigate('/chat')
              setShowConvos(false)
            }}
            className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text transition hover:bg-surface-hover"
          >
            <PlusIcon className="h-4 w-4" /> New chat
          </button>
          {/* Collapse the whole column (md+ only). */}
          <button
            onClick={() => setConvosCollapsed(true)}
            title="Collapse conversations"
            aria-label="Collapse conversations"
            className="hidden md:flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted transition hover:bg-surface-hover"
          >
            <ChevronLeftIcon className="h-4 w-4" />
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
                onClick={() => togglePin(c.id, !c.pinned)}
                title={c.pinned ? 'Unpin chat' : 'Pin chat to top'}
                aria-label={c.pinned ? `Unpin chat ${c.title}` : `Pin chat ${c.title}`}
                className={`ml-1 shrink-0 rounded-md p-1.5 transition hover:bg-surface-hover hover:text-primary ${
                  c.pinned
                    ? 'text-primary opacity-100'
                    : 'text-faint opacity-0 focus:opacity-100 group-hover:opacity-100'
                }`}
              >
                <PinIcon className="h-4 w-4" fill={c.pinned ? 'currentColor' : 'none'} />
              </button>
              <button
                onClick={() => {
                  // The panel belongs to the thread you were in — close it.
                  if (c.id !== conversationId) setPanelArtifact(null)
                  navigate(`/chat/${c.id}`)
                  setShowConvos(false)
                }}
                className={`min-w-0 flex-1 truncate px-2 py-2 text-left text-sm transition ${
                  c.id === conversationId ? 'text-primary' : 'text-muted'
                }`}
              >
                {c.title}
              </button>
              {c.owner_id === user?.id ? (
                <button
                  onClick={() => deleteConversation(c.id, c.title)}
                  title="Delete chat"
                  aria-label={`Delete chat ${c.title}`}
                  className="mr-1 shrink-0 rounded-md p-1.5 text-faint opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              ) : (
                <span className="mr-2 shrink-0 text-faint" title="Shared with you">
                  <UsersIcon className="h-3.5 w-3.5" />
                </span>
              )}
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
            onClick={() => {
              setPanelArtifact(null)
              navigate('/chat')
            }}
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

        {/* Thread header: who's in this conversation + add people. */}
        {conversationId && (
          <div className="relative flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{convo?.title ?? 'Chat'}</span>
            {isGroup && (
              <span className="hidden shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary sm:inline">
                Team thread · @ai to ask the assistant
              </span>
            )}
            <div className="flex shrink-0 -space-x-1.5">
              {[...participantIds].slice(0, 5).map((id) => (
                <span
                  key={id}
                  title={nameOf(id)}
                  className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-primary-soft text-[10px] font-bold text-primary"
                >
                  {realNameOf(id).charAt(0).toUpperCase()}
                </span>
              ))}
            </div>
            <button
              onClick={() => setShowMembers((v) => !v)}
              title="Add people to this chat"
              className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                showMembers ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:bg-surface-hover'
              }`}
            >
              <UsersIcon className="h-4 w-4" /> People
            </button>

            {showMembers && (
              <div className="absolute right-4 top-full z-30 mt-1 max-h-72 w-72 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-xl">
                <p className="px-2 py-1.5 text-xs text-muted">
                  Members can read and post in this thread. The assistant only replies when someone writes{' '}
                  <code className="rounded bg-surface-2 px-1">@ai</code>.
                </p>
                {directory
                  .filter((d) => d.id !== convo?.owner_id)
                  .map((d) => {
                    const checked = memberIds.includes(d.id)
                    return (
                      <button
                        key={d.id}
                        onClick={() => toggleMember(d.id)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-text hover:bg-surface-hover"
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            checked ? 'border-primary bg-primary text-white' : 'border-border-strong text-transparent'
                          }`}
                        >
                          <CheckIcon className="h-3 w-3" />
                        </span>
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[10px] font-bold text-primary">
                          {(d.display_name || d.email || '?').charAt(0).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{d.display_name || d.email}</span>
                          {d.display_name && d.email && (
                            <span className="block truncate text-[11px] text-faint">{d.email}</span>
                          )}
                        </span>
                        {d.id === user?.id && <span className="text-[10px] uppercase text-faint">you</span>}
                      </button>
                    )
                  })}
                {directory.filter((d) => d.id !== convo?.owner_id).length === 0 && (
                  <p className="px-2 py-3 text-center text-xs text-faint">
                    No other members yet — invite people in Settings.
                  </p>
                )}
              </div>
            )}
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
                  isSelf={m.owner_id === user?.id}
                  senderName={isGroup && m.role === 'user' && m.owner_id !== user?.id ? nameOf(m.owner_id) : undefined}
                  attachments={(m.attachments as ChatAttachment[] | null) ?? undefined}
                  onSaveArtifact={
                    m.role === 'assistant' ? () => saveAsArtifact(m.content) : undefined
                  }
                  feedback={m.role === 'assistant' ? feedback[m.id] : undefined}
                  onFeedback={
                    m.role === 'assistant' ? (patch) => saveFeedback(m.id, patch) : undefined
                  }
                  onOpenArtifact={m.role === 'assistant' ? openArtifactPanel : undefined}
                />
              ))}
              {streaming !== null && (
                <MessageBubble role="assistant" content={streaming || ''} streaming />
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

            {/* Collection picker menu (multi-select — combine several) */}
            {showCollections && (
              <div className="absolute bottom-full mb-2 max-h-72 w-full overflow-y-auto rounded-xl border border-border bg-surface shadow-lg">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Chat with collections {collectionIds.length > 0 && `(${collectionIds.length})`}
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate('/artifacts')}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Manage
                  </button>
                </div>
                {collectionIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCollectionIds([])}
                    className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm text-muted hover:bg-surface-hover"
                  >
                    Clear all (chat the whole workspace)
                  </button>
                )}
                {collections.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-faint">
                    No collections yet — group artifacts on the Artifacts page.
                  </p>
                ) : (
                  collections.map((c) => {
                    const checked = collectionIds.includes(c.id)
                    return (
                      <button
                        type="button"
                        key={c.id}
                        onClick={() =>
                          setCollectionIds((prev) =>
                            prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                          )
                        }
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-hover"
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            checked ? 'border-primary bg-primary text-white' : 'border-border-strong text-transparent'
                          }`}
                        >
                          <CheckIcon className="h-3 w-3" />
                        </span>
                        <CollectionIcon className="h-4 w-4 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate text-text">{c.name}</span>
                        {(collectionTokens[c.id] ?? 0) > 0 && (
                          <ContextUsage tokens={collectionTokens[c.id]} model={model} />
                        )}
                        {c.visibility === 'workspace' && (
                          <span className="text-[10px] uppercase tracking-wide text-faint">shared</span>
                        )}
                      </button>
                    )
                  })
                )}
                {collectionIds.length > 1 && (
                  <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted">
                    <span>Combined</span>
                    <ContextUsage tokens={combinedTokens} model={model} />
                  </div>
                )}
              </div>
            )}

            {/* Active collection scope (combined) */}
            {collectionIds.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {collectionIds.map((id) => (
                  <span
                    key={id}
                    className="flex items-center gap-1.5 rounded-lg border border-brand-300 bg-primary-soft px-2 py-1 text-xs font-medium text-primary"
                  >
                    <CollectionIcon className="h-3.5 w-3.5" />
                    <span className="max-w-[180px] truncate">
                      {collections.find((c) => c.id === id)?.name ?? 'Collection'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCollectionIds((prev) => prev.filter((x) => x !== id))}
                      title="Remove from scope"
                      className="text-primary hover:text-primary-strong"
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
                {combinedTokens > 0 && (
                  <span className="flex items-center gap-1">
                    {collectionIds.length > 1 && <span className="text-[11px] text-muted">total</span>}
                    <ContextUsage tokens={combinedTokens} model={model} />
                  </span>
                )}
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
                className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition ${
                  showCollections || collectionIds.length
                    ? 'border-brand-300 bg-primary-soft text-primary'
                    : 'border-border-strong text-muted hover:bg-surface-hover'
                }`}
              >
                <CollectionIcon className="h-5 w-5" />
                {collectionIds.length > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-white">
                    {collectionIds.length}
                  </span>
                )}
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
                placeholder={
                  isGroup
                    ? 'Message the team…  (@ai brings in the assistant, / runs a skill)'
                    : 'Message the assistant…  (type / to run a skill)'
                }
                className="max-h-64 min-h-[120px] flex-1 resize-none rounded-xl border border-border-strong px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft"
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

      {/* Live artifact panel — Claude.ai-style split view. Full-screen overlay
          on mobile, side panel on md+. html artifacts are interactive: clicks
          persist via ArtifactFrame and edits stream in over Realtime. */}
      {panelArtifact && (
        <div
          style={panelResize.panelStyle}
          className="absolute inset-0 z-30 flex flex-col bg-surface md:relative md:inset-auto md:z-auto md:w-[var(--panel-w)] md:shrink-0 md:border-l md:border-border"
        >
          <ResizeHandle onPointerDown={panelResize.onPointerDown} />
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <ArtifactIcon className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
              {panelArtifact.title}
            </span>
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
              {panelArtifact.type}
            </span>
            <button
              onClick={() => navigate(`/artifacts/${panelArtifact.id}`)}
              className="shrink-0 text-xs font-medium text-primary hover:underline"
            >
              Open in editor
            </button>
            <button
              onClick={() => setPanelArtifact(null)}
              title="Close"
              className="shrink-0 rounded-md p-1 text-faint hover:bg-surface-hover hover:text-text"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
          {panelArtifact.type === 'html' ? (
            <ArtifactFrame
              title={panelArtifact.title}
              content={panelArtifact.content}
              data={panelArtifact.data}
              onSave={savePanelData}
              className="min-h-0 w-full flex-1"
            />
          ) : panelArtifact.type === 'markdown' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <Markdown>{panelArtifact.content}</Markdown>
            </div>
          ) : (
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-sm text-text">
              {panelArtifact.content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// The assistant's "thinking/typing" indicator: three dots that bounce one at a
// time (staggered delays), replacing the old block-cursor that rendered as a
// stray white box in some fonts.
function TypingDots({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 align-middle ${className}`}
      role="status"
      aria-label="Assistant is typing"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current animate-typingBounce" />
      <span className="h-1.5 w-1.5 rounded-full bg-current animate-typingBounce [animation-delay:0.2s]" />
      <span className="h-1.5 w-1.5 rounded-full bg-current animate-typingBounce [animation-delay:0.4s]" />
    </span>
  )
}

function MessageBubble({
  role,
  content,
  streaming,
  isSelf = true,
  senderName,
  attachments,
  onSaveArtifact,
  feedback,
  onFeedback,
  onOpenArtifact,
}: {
  role: string
  content: string
  streaming?: boolean
  isSelf?: boolean
  senderName?: string
  attachments?: ChatAttachment[]
  onSaveArtifact?: () => void
  feedback?: FeedbackRow
  onFeedback?: (patch: FeedbackPatch) => void
  onOpenArtifact?: (id: string) => void
}) {
  const isUser = role === 'user'
  // My messages sit right in purple; other humans' sit left in a neutral
  // bubble with their name above, so a shared thread reads like a group chat.
  const alignRight = isUser && isSelf
  // Long pasted context collapses so it doesn't dominate the thread.
  const isLong = isUser && content.length > 600
  const [expanded, setExpanded] = useState(false)
  const shown = isLong && !expanded ? content.slice(0, 500) : content
  return (
    <div className={`flex ${alignRight ? 'justify-end' : 'justify-start'}`}>
      <div className={`group max-w-[85%] ${alignRight ? 'order-2' : ''}`}>
        {senderName && (
          <p className="mb-0.5 px-1 text-[11px] font-semibold text-muted">{senderName}</p>
        )}
        <div
          className={`rounded-2xl px-4 py-2.5 ${
            alignRight
              ? 'bg-primary text-white'
              : isUser
                ? 'bg-surface-2 text-text'
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
                  className={`ml-1 font-medium underline underline-offset-2 ${
                    alignRight ? 'text-brand-100' : 'text-primary'
                  }`}
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </p>
          ) : (
            // Clicking an "open & share →" artifact link opens the live side
            // panel instead of navigating away from the conversation.
            <div
              onClick={(e) => {
                if (!onOpenArtifact) return
                const a = (e.target as HTMLElement).closest('a')
                const m = a?.getAttribute('href')?.match(/^\/artifacts\/([0-9a-f-]{36})$/i)
                if (m) {
                  e.preventDefault()
                  onOpenArtifact(m[1])
                }
              }}
            >
              <Markdown>{content}</Markdown>
            </div>
          )}
          {attachments && attachments.length > 0 && (
            <div className={`mt-2 flex flex-wrap gap-1.5 ${alignRight ? 'justify-end' : ''}`}>
              {attachments.map((a) => (
                <span
                  key={a.path}
                  className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${
                    alignRight ? 'bg-brand-500/40 text-white' : 'bg-surface-2 text-muted'
                  }`}
                >
                  <FileIcon className="h-3 w-3" />
                  <span className="max-w-[140px] truncate">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {streaming && <TypingDots className={content ? 'ml-1' : ''} />}
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
