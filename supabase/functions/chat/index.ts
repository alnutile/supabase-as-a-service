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
import {
  assistantToolCallMsg,
  orApiKey,
  orStream,
  parseToolArgs,
  reasoningParam,
  systemMsg,
  toolResultMsg,
  toORTool,
  WEB_PLUGIN,
  type ORMessage,
  type ORTool,
} from '../_shared/openrouter.ts'

const MAX_ATTACH_BYTES = 6_000_000 // ~6MB per file

const MAX_TOOL_TURNS = 8

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

const CHARS_PER_TOKEN = 4

// Cache OpenRouter's model catalog on the (warm) instance so we can budget the
// injected collection content against the live model's real context window —
// keeping the in-app token meter honest about what actually gets sent.
let MODEL_CTX: Map<string, number> | null = null
async function modelContextLength(slug: string): Promise<number | null> {
  try {
    if (!MODEL_CTX) {
      const res = await fetch('https://openrouter.ai/api/v1/models')
      const json = await res.json()
      MODEL_CTX = new Map()
      for (const m of json?.data ?? []) {
        MODEL_CTX.set(String(m.id).toLowerCase(), Number(m?.context_length ?? 0))
      }
    }
    const s = (slug || '').toLowerCase()
    let v = MODEL_CTX.get(s)
    if (!v) {
      for (const [id, c] of MODEL_CTX) {
        if (id === s || id.endsWith(`/${s}`)) {
          v = c
          break
        }
      }
    }
    return v && v > 0 ? v : null
  } catch {
    return null
  }
}

// Build a context block from one or more collections' artifacts so the user can
// "chat with" a focused set of content. Runs with the service role, so it
// RE-ENFORCES access in code: each collection must be visible to the caller
// (owner / workspace / admin) and only artifacts the caller could read (own or
// non-private) are included. Artifacts shared across selected collections are
// DEDUPED. The total injected size is budgeted to the model's context window
// minus a reserve for the conversation + reply, so it matches the meter the user saw.
async function loadCollectionsContext(
  db: ReturnType<typeof createClient> | null,
  collectionIds: string[],
  userId: string | null,
  model: string,
): Promise<string> {
  if (!db || !userId || !collectionIds.length) return ''
  try {
    const { data: cols } = await db
      .from('collections')
      .select('id, name, owner_id, visibility')
      .in('id', collectionIds)
    if (!cols?.length) return ''

    // Resolve admin once only if some collection isn't owner/workspace-visible.
    const needAdmin = (cols as Array<{ owner_id: string; visibility: string }>).some(
      (c) => c.owner_id !== userId && c.visibility !== 'workspace',
    )
    let isAdmin = false
    if (needAdmin) {
      const { data: prof } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
      isAdmin = Boolean(prof?.is_admin)
    }
    const visible = (cols as Array<{ id: string; name: string; owner_id: string; visibility: string }>).filter(
      (c) => c.owner_id === userId || c.visibility === 'workspace' || isAdmin,
    )
    if (!visible.length) return ''
    const visibleIds = visible.map((c) => c.id)
    const names = visible.map((c) => c.name)

    const { data: links } = await db
      .from('collection_artifacts')
      .select('artifact_id')
      .in('collection_id', visibleIds)
    const ids = [...new Set((links ?? []).map((l: { artifact_id: string }) => l.artifact_id))]

    let readable: Array<{ title: string; type: string; content: string }> = []
    if (ids.length) {
      const { data: arts } = await db
        .from('artifacts')
        .select('id, title, type, content, visibility, owner_id')
        .in('id', ids)
        .order('updated_at', { ascending: false })
      readable = (arts ?? []).filter(
        (a: { owner_id: string; visibility: string }) => a.owner_id === userId || a.visibility !== 'private',
      ) as Array<{ title: string; type: string; content: string }>
    }

    // Files filed into these collections — text files inlined, PDFs via their
    // indexed knowledge text; images/binaries skipped. Budgeted like artifacts.
    const { data: fileLinks } = await db
      .from('collection_files')
      .select('file_id')
      .in('collection_id', visibleIds)
    const fileIds = [...new Set((fileLinks ?? []).map((l: { file_id: string }) => l.file_id))]
    const fileDocs: Array<{ label: string; body: string }> = []
    if (fileIds.length) {
      const { data: files } = await db
        .from('files')
        .select('id, name, mime_type, bucket, path, owner_id, visibility')
        .in('id', fileIds)
      for (const f of (files ?? []).filter(
        (f: { owner_id: string; visibility: string }) => f.owner_id === userId || f.visibility !== 'private',
      ) as Array<{ id: string; name: string; mime_type: string | null; bucket: string | null; path: string }>) {
        const text = await fileToText(db, f, userId)
        if (text) fileDocs.push({ label: `## ${f.name} (file)`, body: text })
      }
    }

    // To-dos filed into these collections — small (title + due + done), so no
    // budgeting needed; readable when owned by the caller or workspace-shared.
    const { data: todoLinks } = await db
      .from('collection_todos')
      .select('todo_id')
      .in('collection_id', visibleIds)
    const todoIds = [...new Set((todoLinks ?? []).map((l: { todo_id: string }) => l.todo_id))]
    let todos: Array<{ title: string; due_date: string | null; done: boolean }> = []
    if (todoIds.length) {
      const { data: t } = await db
        .from('todos')
        .select('title, due_date, done, owner_id, visibility')
        .in('id', todoIds)
        .order('done', { ascending: true })
        .order('due_date', { ascending: true, nullsFirst: false })
      todos = (t ?? []).filter(
        (td: { owner_id: string; visibility: string }) => td.owner_id === userId || td.visibility === 'workspace',
      ) as Array<{ title: string; due_date: string | null; done: boolean }>
    }

    if (!readable.length && !todos.length && !fileDocs.length) return ''

    const parts: string[] = []

    // Budget the large items (artifacts + files) to the model's window. Reserve
    // room (≈20%, clamped) for the running conversation + the reply; the rest is
    // for the collection. Unknown window → a conservative static budget.
    const budgeted: Array<{ label: string; body: string }> = [
      ...readable.map((a) => ({ label: `## ${a.title} (${a.type})`, body: a.content ?? '' })),
      ...fileDocs,
    ]
    if (budgeted.length) {
      const ctxLen = await modelContextLength(model)
      const reserveTokens = ctxLen ? Math.min(Math.max(Math.floor(ctxLen * 0.2), 8000), 32000) : 16000
      const budgetTokens = ctxLen ? Math.max(ctxLen - reserveTokens, 8000) : 50000
      const totalChars = budgetTokens * CHARS_PER_TOKEN

      let total = 0
      let omitted = 0
      for (const d of budgeted) {
        const remaining = totalChars - total
        if (remaining <= 0) {
          omitted = budgeted.length - parts.length
          break
        }
        let body = (d.body ?? '').slice(0, remaining)
        if ((d.body ?? '').length > body.length) body += '\n…(truncated to fit the context window)'
        total += body.length
        parts.push(`${d.label}\n${body}`)
      }
      if (omitted) {
        parts.push(`…(${omitted} more item(s) omitted — the selection exceeds this model's context window.)`)
      }
    }

    if (todos.length) {
      const lines = todos
        .map((t) => `- [${t.done ? 'x' : ' '}] ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`)
        .join('\n')
      parts.push(`## To-dos in this collection\n${lines}`)
    }

    const itemCount = readable.length + fileDocs.length + todos.length
    const label =
      names.length === 1 ? `the "${names[0]}" collection` : `${names.length} collections (${names.map((n) => `"${n}"`).join(', ')})`
    return (
      `# Collection context: ${names.map((n) => `"${n}"`).join(', ')}\n` +
      `The user has scoped this chat to ${label} — ${itemCount} item(s) total. ` +
      `Treat the following as the primary reference content for this conversation; ground your answers in it.\n\n` +
      parts.join('\n\n---\n\n')
    )
  } catch {
    return ''
  }
}

// Turn a collection file into injectable text: an indexed PDF/doc → its
// extracted knowledge text (chunks, scope re-enforced); a text-like file →
// its decoded contents; anything else (images, binaries) → null (skipped).
async function fileToText(
  // deno-lint-ignore no-explicit-any
  db: any,
  f: { id: string; name: string; mime_type: string | null; bucket: string | null; path: string },
  userId: string,
): Promise<string | null> {
  const mime = (f.mime_type ?? '').toLowerCase()
  const MAX = 60000
  try {
    if (mime.includes('pdf') || /\.pdf$/i.test(f.name)) {
      const { data: doc } = await db
        .from('documents')
        .select('id, owner_id, scope, status')
        .eq('file_id', f.id)
        .maybeSingle()
      if (!doc) return '(PDF not indexed yet — its text isn’t available.)'
      if (doc.owner_id !== userId && doc.scope !== 'workspace') return null // not allowed
      const { data: chunks } = await db
        .from('document_chunks')
        .select('content')
        .eq('document_id', doc.id)
        .limit(400)
      const text = (chunks ?? []).map((c: { content: string }) => c.content).join('\n').slice(0, MAX)
      return text || (doc.status === 'done' ? '(no extractable text)' : '(PDF still being indexed.)')
    }
    const textLike =
      mime.startsWith('text/') ||
      ['application/json', 'application/xml', 'application/csv', 'text/csv'].includes(mime) ||
      /\.(md|markdown|txt|csv|tsv|json|ya?ml|log|html?|xml)$/i.test(f.name)
    if (textLike) {
      const { data: blob } = await db.storage.from(f.bucket ?? 'files').download(f.path)
      if (!blob) return null
      const buf = new Uint8Array(await blob.arrayBuffer())
      if (buf.byteLength > 4_000_000) return '(file too large to include inline)'
      return new TextDecoder().decode(buf).slice(0, MAX)
    }
    return null // image / unsupported binary — not injectable as text
  } catch {
    return null
  }
}

async function loadAlwaysOnSystem(db: ReturnType<typeof createClient> | null): Promise<string> {
  if (!db) return DEFAULT_SYSTEM
  try {
    const { data } = await db
      .from('skills')
      .select('instructions, is_builtin, created_at')
      .eq('auto_apply', true)
      .order('is_builtin', { ascending: false })
      .order('created_at', { ascending: true })
    const parts = (data ?? [])
      .map((r: { instructions: string }) => (r.instructions ?? '').trim())
      .filter(Boolean)
    return parts.length ? parts.join('\n\n---\n\n') : DEFAULT_SYSTEM
  } catch {
    return DEFAULT_SYSTEM
  }
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
async function runHttpTool(tool: ToolRow, input: unknown): Promise<string> {
  const url = tool.config?.url
  if (!url) return 'Tool is misconfigured: no url.'
  try {
    const res = await fetch(url, {
      method: tool.config?.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...(tool.config?.headers ?? {}) },
      body: JSON.stringify(input ?? {}),
    })
    const text = await res.text()
    // Cap to keep tool results from blowing the context window.
    return text.slice(0, 50000) || `(empty response, status ${res.status})`
  } catch (err) {
    return `Tool call failed: ${err instanceof Error ? err.message : 'unknown error'}`
  }
}

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
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Bad request' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const db = admin()
  const userId = userIdFromAuth(req)
  const MODEL = await resolveModel(db, 'orchestrator')
  const { tools, httpTools, builtins, mcpRouter, capabilities, webEnabled } = await loadTools(db, toolIds)

  let system: string
  if (replaceSystem && skillSystem.trim()) {
    system = skillSystem
  } else {
    const base = await loadAlwaysOnSystem(db)
    system = skillSystem.trim() ? `${base}\n\n---\n\n${skillSystem}` : base
  }
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
    const blocked = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ delta: `Blocked by workspace guardrail: ${gname}.` }))
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

  const plugins = webEnabled ? [WEB_PLUGIN] : undefined
  const reasoning = reasoningParam()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
          const result = await orStream(
            {
              model: MODEL,
              messages,
              tools: tools.length ? tools : undefined,
              plugins,
              reasoning,
              maxTokens: 16000,
            },
            (delta) => controller.enqueue(sse({ delta })),
          )
          await recordUsage(db, { context: 'chat', model: MODEL, actorId: userId, usage: result.usage })

          if (result.toolCalls.length) {
            // Preserve the assistant turn (content + tool_calls) before results.
            messages.push(assistantToolCallMsg(result.content, result.toolCalls))
            for (const call of result.toolCalls) {
              const name = call.function.name
              const input = parseToolArgs(call.function.arguments)
              const tool = httpTools.get(name)
              let output: string
              if (tool) output = await runHttpTool(tool, input)
              else if (builtins.has(name)) output = await runBuiltin(db, name, input, userId)
              else if (mcpRouter.has(name)) output = await runMcpTool(db, mcpRouter, name, input)
              else output = `Unknown tool: ${name}`
              if (tool || builtins.has(name) || mcpRouter.has(name)) {
                await logActivity(db, 'tool.call', `Used tool: ${name}`, { name }, userId)
              }
              messages.push(toolResultMsg(call.id, output))
            }
            continue
          }

          break // stop / length / content_filter
        }
        controller.enqueue(sse('[DONE]'))
      } catch (err) {
        controller.enqueue(sse({ type: 'error', error: err instanceof Error ? err.message : 'stream failed' }))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})
