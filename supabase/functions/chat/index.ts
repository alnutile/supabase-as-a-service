// Supabase Edge Function: `chat`
// Streams a completion to the browser as SSE. Runs an agentic tool loop: the
// assistant can call tools (web search via the OpenRouter web plugin + custom
// HTTP tools defined in the `tools` table), the function executes them and feeds
// results back, looping until the model is done. The OpenRouter key stays
// server-side (verify_jwt=true).
//
// The system prompt is assembled from the always-on prompts (skills.auto_apply).
// Tools are loaded from the `tools` table (is_active = true).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'
import { resolveModel } from '../_shared/models.ts'
import { runGuardrails } from '../_shared/guardrails.ts'
import { runBuiltin } from '../_shared/builtins.ts'
import { expandMcpTools, runMcpTool, type McpRouter } from '../_shared/mcp.ts'
import { recordUsage } from '../_shared/usage.ts'
import { RunRecorder } from '../_shared/run_recorder.ts'
import { loadCollectionsContext } from '../_shared/collections.ts'
import { loadAlwaysOnPrompts } from '../_shared/always_on.ts'
import { parseArtifactBlocks } from '../_shared/artifacts.ts'
import { cardsToText } from '../_shared/card_board.ts'
import { loadUserMemories } from '../_shared/memory.ts'
import { currentTimeSection, resolveWorkspaceTimezone } from '../_shared/timezone.ts'
import { runHttpTool } from '../_shared/http_tool.ts'
import {
  assistantToolCallMsg,
  orApiKey,
  orStream,
  parseToolArgs,
  reasoningParam,
  systemMsg,
  toolResultMsg,
  toORTool,
  WEB_SEARCH_TOOL,
  type ORMessage,
  type ORTool,
} from '../_shared/openrouter.ts'

const MAX_ATTACH_BYTES = 6_000_000 // ~6MB per file

// How many model→tool→model round-trips a single reply may take. A genuinely
// long agentic task (search → read → cross-reference → write) can need more than
// a handful, and hitting the cap ends the reply mid-work. Kept bounded so a
// misbehaving loop can't run away; the background task + heartbeat keep the run
// alive long enough to use them.
const MAX_TOOL_TURNS = 16

const DEFAULT_SYSTEM = `You are the assistant inside a Supabase-powered intranet. Be warm, concise, and practical.

When the user asks you to create, save, or share an artifact (a doc, code file, HTML page, etc.), output it as ONE block in EXACTLY this format:

:::artifact {"title":"Short title","type":"markdown"}
...the full content...
:::

"type" is one of: markdown, code, html, text. Put only the content between the fences; don't wrap the block in code fences. The app saves it as a shareable artifact automatically.`

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface Attachment {
  path: string
  name: string
  mime?: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  attachments?: Attachment[]
}

interface ToolRow {
  id: string
  name: string
  description: string
  input_schema: Record<string, unknown>
  kind: string
  config: { url?: string; method?: string; headers?: Record<string, string> }
}

function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

// Thrown by push() when the client has disconnected AND we're not persisting in
// the background — it unwinds the run so a reader that vanished stops the model
// loop (saving cost), exactly as enqueue-throwing did before. In persist mode
// push() swallows instead, so the background task runs to completion.
class ClientGoneError extends Error {}

function admin() {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  return url && key ? createClient(url, key) : null
}

// Decode the user id (sub) from the forwarded access token (verify_jwt already
// validated it upstream — we only read the claim for attribution).
function userIdFromAuth(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const json = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json.sub === 'string' ? json.sub : null
  } catch {
    return null
  }
}

// Turn a message with file attachments into OpenAI/OpenRouter content blocks
// (image_url / file / inlined text), downloading each file from storage with the
// service role. Messages without attachments stay as plain strings.
async function expandContent(
  db: ReturnType<typeof createClient> | null,
  msg: ChatMessage,
): Promise<unknown> {
  if (!db || !msg.attachments || msg.attachments.length === 0) return msg.content
  const blocks: unknown[] = [{ type: 'text', text: msg.content || '(see attached files)' }]
  for (const att of msg.attachments) {
    try {
      const { data: blob } = await db.storage.from('files').download(att.path)
      if (!blob) continue
      const buf = new Uint8Array(await blob.arrayBuffer())
      if (buf.byteLength > MAX_ATTACH_BYTES) {
        blocks.push({ type: 'text', text: `(Attached file "${att.name}" is too large to read.)` })
        continue
      }
      const mime = att.mime ?? ''
      if (mime.startsWith('image/')) {
        blocks.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${encodeBase64(buf)}` } })
      } else if (mime === 'application/pdf') {
        blocks.push({
          type: 'file',
          file: { filename: att.name, file_data: `data:application/pdf;base64,${encodeBase64(buf)}` },
        })
      } else {
        const text = new TextDecoder().decode(buf).slice(0, 60000)
        blocks.push({ type: 'text', text: `Attached file "${att.name}":\n\n${text}` })
      }
    } catch {
      blocks.push({ type: 'text', text: `(Could not read attached file "${att.name}".)` })
    }
  }
  return blocks
}

async function logActivity(
  db: ReturnType<typeof createClient> | null,
  type: string,
  summary: string,
  detail: Record<string, unknown>,
  actorId: string | null,
) {
  if (!db) return
  try {
    await db.from('activity_log').insert({ type, summary, detail, actor_id: actorId })
  } catch {
    // best-effort
  }
}

// Did the user hit Stop for THIS run? The client writes conversations
// .cancel_requested_run = runId on Stop; the background task checks this between
// tool turns and right before it persists. Scoped by runId so a stale marker
// from a previous, finished run never cancels the next one. Best-effort: a read
// error means "not cancelled" (fail toward saving the reply, not dropping it).
async function isRunCancelled(
  db: ReturnType<typeof createClient> | null,
  conversationId: string,
  runId: string,
): Promise<boolean> {
  if (!db || !conversationId || !runId) return false
  try {
    const { data } = await db
      .from('conversations')
      .select('cancel_requested_run')
      .eq('id', conversationId)
      .maybeSingle()
    return data?.cancel_requested_run === runId
  } catch {
    return false
  }
}

// loadCollectionsContext (+ its file/model helpers) now lives in
// ../_shared/collections.ts so chat, webhook, and scheduler all inject an
// agent's bound collections the same way.

async function loadAlwaysOnSystem(db: ReturnType<typeof createClient> | null): Promise<string> {
  const joined = await loadAlwaysOnPrompts(db)
  return joined || DEFAULT_SYSTEM
}

// Build the OpenAI/OpenRouter `tools` array from active rows, and a lookup of the
// custom (http) tools so we can execute them when the model calls them.
// `restrictIds` (when an agent is driving the chat) limits the exposed tools to
// the agent's chosen set. undefined = all active tools. A `kind='web'` row turns
// on the OpenRouter web plugin (webEnabled) rather than adding a tool.
async function loadTools(
  db: ReturnType<typeof createClient> | null,
  restrictIds?: string[] | null,
) {
  const tools: ORTool[] = []
  const httpTools = new Map<string, ToolRow>()
  const builtins = new Set<string>()
  const mcpRows: ToolRow[] = []
  let mcpRouter: McpRouter = new Map()
  const capabilities: string[] = []
  let webEnabled = false
  if (!db) return { tools, httpTools, builtins, mcpRouter, capabilities, webEnabled }
  try {
    const { data } = await db.from('tools').select('*').eq('is_active', true)
    for (const t of (data ?? []) as ToolRow[]) {
      if (restrictIds && !restrictIds.includes(t.id)) continue
      if (t.kind === 'web') {
        webEnabled = true
      } else if (t.kind === 'builtin' && t.name) {
        tools.push(toORTool(t.name, t.description, t.input_schema))
        builtins.add(t.name)
        capabilities.push(`\`${t.name}\` — ${t.description}`)
      } else if (t.kind === 'http' && t.name) {
        tools.push(toORTool(t.name, t.description, t.input_schema))
        httpTools.set(t.name, t)
        capabilities.push(`\`${t.name}\` — ${t.description}`)
      } else if (t.kind === 'mcp') {
        mcpRows.push(t)
      }
    }
    // Expand any connected MCP servers into first-class, namespaced tools.
    const mcp = await expandMcpTools(db, mcpRows)
    for (const mt of mcp.tools) tools.push(mt)
    for (const c of mcp.capabilities) capabilities.push(c)
    mcpRouter = mcp.router
    if (webEnabled) {
      capabilities.unshift('Web browsing — search the web for current information')
    }
  } catch {
    // tools are optional — degrade to no tools
  }
  return { tools, httpTools, builtins, mcpRouter, capabilities, webEnabled }
}

// Built-in tools (search_documents, send_email, check_email) are executed by the
// shared runBuiltin() in ../_shared/builtins.ts so chat, webhook, and scheduler
// all run them identically.

// Execute a custom http tool: POST the model's inputs to the configured URL.
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS })

  if (!orApiKey()) {
    return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY is not configured' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  let inMessages: ChatMessage[]
  let skillSystem = ''
  let replaceSystem = false
  let toolIds: string[] | undefined
  let collectionIds: string[] = []
  let cardBoardId = ''
  // Server-side persistence: the main chat composer passes conversationId +
  // persist so the assistant reply is written HERE (in a background task that
  // survives the browser navigating away / reloading), plus a per-send runId
  // used to honor a Stop. Skill/board/collection chats omit these and keep
  // client-side persistence, unchanged.
  let conversationId = ''
  let persist = false
  let runId = ''
  // When the chat is driving a specific agent (?agent=id), record a run trace so
  // it appears on the agent's observability page. Null for plain user chat.
  let agentId = ''
  try {
    const body = await req.json()
    inMessages = body.messages
    if (!Array.isArray(inMessages) || inMessages.length === 0) {
      throw new Error('`messages` must be a non-empty array')
    }
    if (typeof body.system === 'string') skillSystem = body.system
    replaceSystem = body.replaceSystem === true
    if (Array.isArray(body.toolIds)) toolIds = body.toolIds.map(String)
    // Accept an array of collection ids (multi-scope) or a single legacy id.
    if (Array.isArray(body.collectionIds)) collectionIds = body.collectionIds.map(String).filter(Boolean)
    else if (typeof body.collectionId === 'string' && body.collectionId) collectionIds = [body.collectionId]
    // Scope a chat directly to one card board (the Cards editor's chat panel).
    if (typeof body.cardBoardId === 'string') cardBoardId = body.cardBoardId
    if (typeof body.conversationId === 'string') conversationId = body.conversationId
    persist = body.persist === true
    if (typeof body.runId === 'string') runId = body.runId
    if (typeof body.agentId === 'string') agentId = body.agentId
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Bad request' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const db = admin()
  const userId = userIdFromAuth(req)
  // Own the assistant write only when the caller asked for it and we can
  // attribute + target it. Everything else streams exactly as before.
  const doPersist = persist && !!conversationId && !!userId && !!db
  const MODEL = await resolveModel(db, 'orchestrator')
  const { tools, httpTools, builtins, mcpRouter, capabilities, webEnabled } = await loadTools(db, toolIds)

  let system: string
  if (replaceSystem && skillSystem.trim()) {
    system = skillSystem
  } else {
    const base = await loadAlwaysOnSystem(db)
    system = skillSystem.trim() ? `${base}\n\n---\n\n${skillSystem}` : base
  }
  // Prepend the workspace-local date/time so the assistant reasons about
  // "today/now" in the team's timezone instead of assuming UTC.
  const tz = await resolveWorkspaceTimezone(db)
  system = `${currentTimeSection(tz, new Date())}\n\n---\n\n${system}`
  // Make the system layer declare the live capability set, so the assistant
  // always knows which tools/abilities it currently has.
  if (capabilities.length) {
    system += `\n\n# Tools available to you right now\n${capabilities
      .map((c) => `- ${c}`)
      .join('\n')}\nUse them whenever they help. You also create shareable artifacts with the :::artifact protocol.`
  }

  // Collection scope: inject the chosen collection's artifacts as primary context.
  if (collectionIds.length) {
    const collectionContext = await loadCollectionsContext(db, collectionIds, userId, MODEL)
    if (collectionContext) system += `\n\n---\n\n${collectionContext}`
  }

  // Card-board scope (the Cards editor's chat panel): inject THIS board's cards
  // as primary context. Re-enforce access in code (service role bypasses RLS):
  // the caller must own the board or it must be workspace-visible.
  if (cardBoardId) {
    const { data: cb } = await db
      .from('card_boards')
      .select('title, cards, owner_id, visibility')
      .eq('id', cardBoardId)
      .maybeSingle()
    if (cb && (cb.owner_id === userId || cb.visibility === 'workspace')) {
      system +=
        `\n\n---\n\n# Card board: "${cb.title}" (id ${cardBoardId})\n` +
        `The user is chatting from this card board. Treat it as the primary reference. ` +
        `To add ideas as cards, call add_cards with id "${cardBoardId}" and a cards array of {text, color?}; ` +
        `to re-read it call get_card_board with that id. The board updates live as you add cards.\n\n` +
        cardsToText({ cards: cb.cards })
    }
  }

  // User memory: inject what the assistant remembers about this user, so a new
  // chat starts from their known defaults/preferences instead of a blank slate.
  const memoryContext = await loadUserMemories(db, userId)
  if (memoryContext) system += `\n\n---\n\n${memoryContext}`

  // Guardrails (chat context): cheap utility-model pre-flight on the latest user
  // message. Makes NO model call when there are no active chat guardrails. Chat
  // fails OPEN — a signed-in human is present, availability beats a flaky gate.
  const lastUser = inMessages[inMessages.length - 1]
  const lastText = lastUser && lastUser.role === 'user' ? lastUser.content : ''
  const guard = await runGuardrails(db, 'chat', lastText, userId)
  if (guard.ok === false && 'error' in guard) {
    await logActivity(db, 'guardrail.error', 'Guardrail check errored (chat — proceeding)', { error: guard.error }, userId)
  } else if (guard.ok === false && guard.blocked) {
    const gname = guard.violations[0].name
    await logActivity(db, 'guardrail.blocked', `Blocked chat message — ${gname}`, { violations: guard.violations }, userId)
    const text = `Blocked by workspace guardrail: ${gname}.`
    // In persist mode the server owns the assistant write, so persist the block
    // notice here (and hand the saved row back over SSE) — the client no longer
    // inserts it itself, and it must survive a reload like any other reply.
    let savedRow: unknown = null
    if (doPersist) {
      const { data: msg } = await db!
        .from('messages')
        .insert({ conversation_id: conversationId, owner_id: userId, role: 'assistant', content: text })
        .select()
        .single()
      savedRow = msg ?? null
      if (msg) {
        await db!.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId)
      }
    }
    const blocked = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ delta: text }))
        if (savedRow) controller.enqueue(sse({ message: savedRow }))
        controller.enqueue(sse('[DONE]'))
        controller.close()
      },
    })
    return new Response(blocked, {
      headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    })
  } else if (guard.ok === false) {
    await logActivity(db, 'guardrail.flagged', `Flagged chat message — ${guard.violations[0].name}`, { violations: guard.violations }, userId)
  }

  // Conversation messages, mutated across tool turns. The system prompt is the
  // first message (OpenAI shape), followed by the conversation history.
  const messages: ORMessage[] = [systemMsg(system)]
  for (const m of inMessages) {
    messages.push({ role: m.role, content: await expandContent(db, m) })
  }

  if (webEnabled) tools.push(WEB_SEARCH_TOOL)
  const reasoning = reasoningParam()

  // The model loop is decoupled from the client stream so it can outlive the
  // browser. We push deltas to the client best-effort; if the client is gone
  // and we're persisting, we keep working and drop the output (the reply still
  // lands in the DB). If the client is gone and we're NOT persisting, push()
  // throws to unwind the run — a vanished reader shouldn't burn tokens.
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  let clientGone = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
    },
    cancel() {
      // The browser tab closed, reloaded, navigated away, or hit Stop.
      clientGone = true
    },
  })

  const push = (chunk: Uint8Array) => {
    if (clientGone) {
      if (doPersist) return
      throw new ClientGoneError()
    }
    try {
      controllerRef?.enqueue(chunk)
    } catch {
      clientGone = true
      if (!doPersist) throw new ClientGoneError()
    }
  }
  const closeStream = () => {
    if (clientGone) return
    try {
      controllerRef?.close()
    } catch {
      // already closed / errored
    }
    clientGone = true
  }

  // Keep the streamed connection alive during idle gaps. A long-running turn can
  // go a minute or more with NO bytes to send — while a slow tool runs (http /
  // MCP / builtin) or the model "thinks" before its first token. Intermediate
  // proxies drop an idle SSE connection after ~1–2 min, so the browser's reader
  // ends early and the typing indicator disappears as if it timed out, even
  // though the background task is still running and will persist the reply. A
  // lightweight SSE comment every 15s keeps bytes flowing. Comments (": …") are
  // ignored by the client SSE parser (it only acts on "data:" lines) and by
  // orStream, so they never corrupt the delta stream. We enqueue directly (not
  // via push) so a heartbeat never throws ClientGoneError to unwind the run.
  const HEARTBEAT_MS = 15_000
  const encoder = new TextEncoder()
  let heartbeat: number | undefined
  const startHeartbeat = () => {
    heartbeat = setInterval(() => {
      if (clientGone) return
      try {
        controllerRef?.enqueue(encoder.encode(': ping\n\n'))
      } catch {
        clientGone = true
      }
    }, HEARTBEAT_MS)
  }
  const stopHeartbeat = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = undefined
  }

  // Materialize :::artifact blocks server-side (insert rows as the caller, swap
  // in share links) and persist the assistant message + touch the conversation.
  // Mirrors ChatPage.materializeArtifacts so the protocol behaves identically
  // when the server owns the write. Emits the created artifact/message rows over
  // SSE so a still-connected client updates instantly (its Realtime subscription
  // dedupes the echo); a disconnected client picks them up on remount.
  const persistReply = async (fullText: string): Promise<void> => {
    let out = ''
    for (const chunk of parseArtifactBlocks(fullText)) {
      if (chunk.kind === 'text') {
        out += chunk.text
        continue
      }
      const { data: art } = await db!
        .from('artifacts')
        .insert({
          owner_id: userId,
          conversation_id: conversationId,
          title: chunk.title,
          type: chunk.type,
          content: chunk.content,
          visibility: 'private',
        })
        .select()
        .single()
      if (art) push(sse({ artifact: art }))
      out += art
        ? `✺ **${chunk.title}** — [open & share →](/artifacts/${art.id})`
        : `**${chunk.title}** (couldn’t save)`
    }
    if (!out.trim()) return // nothing to save (e.g. a pure tool run with no text)
    const { data: msg } = await db!
      .from('messages')
      .insert({ conversation_id: conversationId, owner_id: userId, role: 'assistant', content: out })
      .select()
      .single()
    if (msg) push(sse({ message: msg }))
    await db!.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId)
  }

  // Attribute this run to its agent (if any) so it appears on /agents/:id. Uses
  // the last user turn as the run's "input". Best-effort; null for plain chat.
  const lastUserText = (() => {
    for (let i = inMessages.length - 1; i >= 0; i--) {
      const m = inMessages[i]
      if (m?.role === 'user' && typeof m.content === 'string') return m.content
    }
    return ''
  })()

  const task = (async () => {
    let full = ''
    let runError: string | null = null
    const rec = await RunRecorder.open(db, {
      agentId: agentId || null,
      ownerId: userId,
      surface: 'chat',
      triggerRef: { conversation_id: conversationId },
      model: MODEL,
      input: lastUserText,
    })
    startHeartbeat()
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const result = await orStream(
          {
            model: MODEL,
            messages,
            tools: tools.length ? tools : undefined,
            reasoning,
            maxTokens: 16000,
          },
          (delta) => {
            full += delta
            push(sse({ delta }))
          },
        )
        await recordUsage(db, { context: 'chat', model: MODEL, actorId: userId, usage: result.usage })
        await rec?.modelTurn(result.content, result.usage)

        // The user hit Stop mid-run: halt, save nothing, don't run more turns.
        if (doPersist && (await isRunCancelled(db, conversationId, runId))) {
          closeStream()
          return
        }

        if (result.toolCalls.length) {
          // Preserve the assistant turn (content + tool_calls) before results.
          messages.push(assistantToolCallMsg(result.content, result.toolCalls))
          for (const call of result.toolCalls) {
            const name = call.function.name
            const input = parseToolArgs(call.function.arguments)
            const tool = httpTools.get(name)
            let output: string
            const started = Date.now()
            if (tool) output = await runHttpTool(db, tool, input)
            else if (builtins.has(name)) output = await runBuiltin(db, name, input, userId)
            else if (mcpRouter.has(name)) output = await runMcpTool(db, mcpRouter, name, input)
            else output = `Unknown tool: ${name}`
            if (tool || builtins.has(name) || mcpRouter.has(name)) {
              await logActivity(db, 'tool.call', `Used tool: ${name}`, { name }, userId)
              await rec?.toolStep({ name, input, output, durationMs: Date.now() - started })
            }
            messages.push(toolResultMsg(call.id, output))
          }
          continue
        }

        break // stop / length / content_filter
      }

      // Persist BEFORE [DONE] so a still-connected client receives the saved row
      // and the DB is written by the time the stream ends. Re-check the Stop
      // marker one last time to close the "Stop landed as the model finished"
      // race — if cancelled, save nothing.
      if (doPersist) {
        if (await isRunCancelled(db, conversationId, runId)) {
          closeStream()
          return
        }
        await persistReply(full)
      }
      push(sse('[DONE]'))
    } catch (err) {
      // A non-persist run whose reader vanished — nothing to surface, just stop.
      if (err instanceof ClientGoneError) return
      // The model/tool loop blew up. Surface a legible message to a connected
      // client (orStream already parses the raw OpenRouter blob into a friendly
      // line) AND record it in Activity so failures are visible after the fact.
      const message = err instanceof Error ? err.message : 'stream failed'
      runError = message
      await logActivity(db, 'chat.error', `Chat failed — ${message}`.slice(0, 200), { error: message, model: MODEL }, userId)
      try {
        push(sse({ type: 'error', error: message }))
      } catch {
        // client gone — the Activity log above is the durable record
      }
    } finally {
      // Close the run trace exactly once, whatever exit path (done, Stop, error,
      // client-gone) — so the row never stays stuck 'running'.
      await rec?.finish({ status: runError ? 'error' : 'done', finalOutput: full, error: runError })
      stopHeartbeat()
      closeStream()
    }
  })()

  // Keep the worker alive for the background task so a disconnect doesn't kill
  // the run (same pattern as slack-events / loop / evals). Locally there's no
  // EdgeRuntime — leave the promise floating so the Response still streams while
  // it runs (awaiting it here would block the stream from starting).
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime
  if (er && typeof er.waitUntil === 'function') er.waitUntil(task)

  return new Response(body, {
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})
