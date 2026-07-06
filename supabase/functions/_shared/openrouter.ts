// Shared OpenRouter client. OpenRouter is OpenAI-compatible
// (POST https://openrouter.ai/api/v1/chat/completions), so this is a thin fetch
// wrapper rather than the OpenAI SDK — that lets us pass the extra fields
// OpenRouter adds (`reasoning`, `plugins`) without fighting SDK types. ALL model
// calls (chat, webhook, scheduler, guardrails) go through here so the request
// shape, auth, and reasoning/effort handling stay identical everywhere.
//
// Model ids are OpenRouter slugs (e.g. 'anthropic/claude-sonnet-4.5') resolved
// from the model_profiles table via ../_shared/models.ts — never hardcoded.

import { describeModelError } from './errors.ts'

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions'

export type Effort = 'low' | 'medium' | 'high'

export type ORTool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type ORToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

// OpenAI-shaped chat message. `content` is a string for plain text, or an array
// of content blocks (text / image_url / file) for multimodal user turns.
export type ORMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  // deno-lint-ignore no-explicit-any
  content: any
  tool_calls?: ORToolCall[]
  tool_call_id?: string
}

export function orApiKey(): string | undefined {
  return Deno.env.get('OPENROUTER_API_KEY')
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${Deno.env.get('OPENROUTER_API_KEY') ?? ''}`,
    'Content-Type': 'application/json',
  }
  // Optional ranking headers (https://openrouter.ai/docs).
  const ref = Deno.env.get('OPENROUTER_SITE_URL')
  if (ref) h['HTTP-Referer'] = ref
  const title = Deno.env.get('OPENROUTER_APP_NAME')
  if (title) h['X-Title'] = title
  return h
}

// Effort tier → OpenRouter's `reasoning.effort` (replaces Anthropic's
// output_config.effort). Reads OPENROUTER_EFFORT, falling back to the legacy
// ANTHROPIC_EFFORT so existing deployments don't lose the setting.
export function reasoningParam(): { effort: Effort } | undefined {
  const e = Deno.env.get('OPENROUTER_EFFORT') ?? Deno.env.get('ANTHROPIC_EFFORT')
  if (e === 'low' || e === 'medium' || e === 'high') return { effort: e }
  return undefined
}

export interface ORRequest {
  model: string
  messages: ORMessage[]
  tools?: ORTool[]
  plugins?: Array<Record<string, unknown>>
  reasoning?: { effort: Effort }
  maxTokens?: number
}

function buildBody(req: ORRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    max_tokens: req.maxTokens ?? 4096,
    stream,
  }
  if (req.tools && req.tools.length) body.tools = req.tools
  if (req.plugins && req.plugins.length) body.plugins = req.plugins
  if (req.reasoning) body.reasoning = req.reasoning
  return body
}

// Token + cost accounting. OpenRouter returns this automatically on every
// response (last SSE chunk when streaming). `cost` is in USD credits; it can be
// null for providers/models that don't report a price.
export interface ORUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number | null
  reasoningTokens: number
  cachedTokens: number
  raw: Record<string, unknown>
}

// deno-lint-ignore no-explicit-any
function mapUsage(raw: any): ORUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  return {
    promptTokens: Number(raw.prompt_tokens ?? 0),
    completionTokens: Number(raw.completion_tokens ?? 0),
    totalTokens: Number(raw.total_tokens ?? 0),
    cost: typeof raw.cost === 'number' ? raw.cost : null,
    reasoningTokens: Number(raw.completion_tokens_details?.reasoning_tokens ?? 0),
    cachedTokens: Number(raw.prompt_tokens_details?.cached_tokens ?? 0),
    raw,
  }
}

export interface ORResult {
  content: string
  toolCalls: ORToolCall[]
  finishReason: string
  usage?: ORUsage
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text ?? '') : ''))
      .join('')
  }
  return ''
}

// Non-streaming completion (webhook, scheduler, guardrails). Returns the
// assistant text, any tool calls, and the finish reason.
export async function orComplete(req: ORRequest): Promise<ORResult> {
  const res = await fetch(OR_URL, { method: 'POST', headers: headers(), body: JSON.stringify(buildBody(req, false)) })
  if (!res.ok) {
    throw new Error(describeModelError(res.status, await res.text().catch(() => '')))
  }
  const data = await res.json()
  const choice = data?.choices?.[0] ?? {}
  const msg = choice.message ?? {}
  return {
    content: textOfContent(msg.content),
    toolCalls: Array.isArray(msg.tool_calls) ? (msg.tool_calls as ORToolCall[]) : [],
    finishReason: choice.finish_reason ?? 'stop',
    usage: mapUsage(data?.usage),
  }
}

// Streaming completion (chat). Calls `onText` for each text delta and resolves
// with the assembled text + accumulated tool calls + finish reason. OpenAI-style
// SSE: tool_calls arrive in fragments keyed by `index`; we stitch them together.
export async function orStream(req: ORRequest, onText: (delta: string) => void): Promise<ORResult> {
  const res = await fetch(OR_URL, { method: 'POST', headers: headers(), body: JSON.stringify(buildBody(req, true)) })
  if (!res.ok || !res.body) {
    throw new Error(describeModelError(res.status, await res.text().catch(() => '')))
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason = 'stop'
  let usage: ORUsage | undefined
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      // Skip blank lines and OpenRouter keep-alive comments (": ...").
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      // deno-lint-ignore no-explicit-any
      let json: any
      try {
        json = JSON.parse(payload)
      } catch {
        continue // partial — should not happen on line boundaries, but be safe
      }
      // The final chunk carries usage and usually has no choices — capture it
      // before the choice guard.
      if (json?.usage) usage = mapUsage(json.usage)
      const choice = json?.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        onText(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0
          const cur = toolAcc.get(idx) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments
          toolAcc.set(idx, cur)
        }
      }
    }
  }

  const toolCalls: ORToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id, type: 'function', function: { name: v.name, arguments: v.args || '{}' } }))
  return { content, toolCalls, finishReason, usage }
}

// --- helpers shared by the call sites -------------------------------------

export function systemMsg(text: string): ORMessage {
  return { role: 'system', content: text }
}

export function toolResultMsg(toolCallId: string, output: string): ORMessage {
  return { role: 'tool', tool_call_id: toolCallId, content: output }
}

// The assistant turn to push back into history before sending tool results.
export function assistantToolCallMsg(content: string, toolCalls: ORToolCall[]): ORMessage {
  return { role: 'assistant', content: content || '', tool_calls: toolCalls }
}

export function toORTool(name: string, description: string, schema: Record<string, unknown> | undefined): ORTool {
  const parameters = schema && Object.keys(schema).length ? schema : { type: 'object', properties: {} }
  return { type: 'function', function: { name, description, parameters } }
}

// Parse a tool call's JSON-string arguments into an object (OpenAI sends
// `function.arguments` as a string).
export function parseToolArgs(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args || '{}')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// OpenRouter web search plugin — the portable replacement for Anthropic's
// server-side web_search/web_fetch. Works with any model.
export const WEB_PLUGIN = { id: 'web' }
