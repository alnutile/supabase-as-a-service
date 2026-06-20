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
  const capabilities: string[] = []
  let webEnabled = false
  if (!db) return { tools, httpTools, builtins, capabilities, webEnabled }
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
      }
    }
    if (webEnabled) {
      capabilities.unshift('Web browsing — search the web for current information')
    }
  } catch {
    // tools are optional — degrade to no tools
  }
  return { tools, httpTools, builtins, capabilities, webEnabled }
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
  try {
    const body = await req.json()
    inMessages = body.messages
    if (!Array.isArray(inMessages) || inMessages.length === 0) {
      throw new Error('`messages` must be a non-empty array')
    }
    if (typeof body.system === 'string') skillSystem = body.system
    replaceSystem = body.replaceSystem === true
    if (Array.isArray(body.toolIds)) toolIds = body.toolIds.map(String)
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Bad request' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const db = admin()
  const userId = userIdFromAuth(req)
  const MODEL = await resolveModel(db, 'orchestrator')
  const { tools, httpTools, builtins, capabilities, webEnabled } = await loadTools(db, toolIds)

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

  // Guardrails (chat context): cheap utility-model pre-flight on the latest user
  // message. Makes NO model call when there are no active chat guardrails. Chat
  // fails OPEN — a signed-in human is present, availability beats a flaky gate.
  const lastUser = inMessages[inMessages.length - 1]
  const lastText = lastUser && lastUser.role === 'user' ? lastUser.content : ''
  const guard = await runGuardrails(db, 'chat', lastText)
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
              else output = `Unknown tool: ${name}`
              if (tool || builtins.has(name)) {
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
