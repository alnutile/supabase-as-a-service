// Supabase Edge Function: `webhook` (PUBLIC — verify_jwt=false).
// External systems POST to /functions/v1/webhook/<token>. We resolve the webhook
// by token and process the payload: either with the webhook's own prompt, or —
// if an agent is attached — by running that agent (its instructions + its tools)
// over the payload through a non-streaming agentic loop. The event is logged.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { resolveModel } from '../_shared/models.ts'
import { runGuardrails } from '../_shared/guardrails.ts'
import { runBuiltin } from '../_shared/builtins.ts'
import { expandMcpTools, runMcpTool, type McpRouter } from '../_shared/mcp.ts'
import { recordUsage } from '../_shared/usage.ts'
import {
  assistantToolCallMsg,
  orApiKey,
  orComplete,
  parseToolArgs,
  reasoningParam,
  toolResultMsg,
  toORTool,
  WEB_PLUGIN,
  type ORMessage,
  type ORTool,
} from '../_shared/openrouter.ts'

const MAX_TOOL_TURNS = 6

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface ToolRow {
  id: string
  name: string
  description: string
  input_schema: Record<string, unknown>
  kind: string
  config: { url?: string; method?: string; headers?: Record<string, string> }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function extractToken(url: URL): string | null {
  const q = url.searchParams.get('token')
  if (q) return q.trim()
  const parts = url.pathname.split('/').filter(Boolean)
  const i = parts.indexOf('webhook')
  if (i !== -1 && parts[i + 1]) return parts[i + 1]
  const last = parts[parts.length - 1]
  return last && last !== 'webhook' ? last : null
}

// deno-lint-ignore no-explicit-any
async function loadAgentTools(db: any, restrictIds: string[]) {
  const tools: ORTool[] = []
  const httpTools = new Map<string, ToolRow>()
  const builtins = new Set<string>()
  const mcpRows: ToolRow[] = []
  let mcpRouter: McpRouter = new Map()
  let webEnabled = false
  if (!restrictIds.length) return { tools, httpTools, builtins, mcpRouter, webEnabled }
  const { data } = await db.from('tools').select('*').eq('is_active', true)
  for (const t of (data ?? []) as ToolRow[]) {
    if (!restrictIds.includes(t.id)) continue
    if (t.kind === 'web') webEnabled = true
    else if (t.kind === 'builtin' && t.name) {
      tools.push(toORTool(t.name, t.description, t.input_schema))
      builtins.add(t.name)
    } else if (t.kind === 'http' && t.name) {
      tools.push(toORTool(t.name, t.description, t.input_schema))
      httpTools.set(t.name, t)
    } else if (t.kind === 'mcp') {
      mcpRows.push(t)
    }
  }
  const mcp = await expandMcpTools(db, mcpRows)
  for (const mt of mcp.tools) tools.push(mt)
  mcpRouter = mcp.router
  return { tools, httpTools, builtins, mcpRouter, webEnabled }
}

async function runHttpTool(tool: ToolRow, input: unknown): Promise<string> {
  const url = tool.config?.url
  if (!url) return 'Tool is misconfigured: no url.'
  try {
    const res = await fetch(url, {
      method: tool.config?.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...(tool.config?.headers ?? {}) },
      body: JSON.stringify(input ?? {}),
    })
    return (await res.text()).slice(0, 50000)
  } catch (err) {
    return `Tool call failed: ${err instanceof Error ? err.message : 'error'}`
  }
}

function jsonType(v: unknown): string {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

// Validate an inbound payload against a tool's input_schema (a JSON Schema). A
// pragmatic subset: required-field presence + top-level type checks for declared
// properties. Returns a list of human-readable problems (empty = valid).
function validatePayload(schema: Record<string, unknown>, payload: unknown): string[] {
  if (jsonType(payload) !== 'object') return ['payload must be a JSON object']
  const obj = payload as Record<string, unknown>
  const props = (schema?.properties ?? {}) as Record<string, { type?: string }>
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : []
  const errors: string[] = []
  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) errors.push(`missing required field "${key}"`)
  }
  for (const [key, spec] of Object.entries(props)) {
    const val = obj[key]
    if (val === undefined || val === null) continue
    const want = spec?.type
    if (!want) continue
    const got = jsonType(val)
    const ok =
      want === 'integer' ? got === 'number' && Number.isInteger(val) :
      want === 'number' ? got === 'number' :
      got === want
    if (!ok) errors.push(`field "${key}" should be ${want}, got ${got}`)
  }
  return errors
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const url = new URL(req.url)
  const token = extractToken(url)
  if (!token) return json({ error: 'Missing webhook token' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey || !orApiKey()) return json({ error: 'Server not configured' }, 500)
  const db = createClient(supabaseUrl, serviceKey)

  const { data: webhook } = await db
    .from('webhooks')
    .select('id, owner_id, name, prompt, is_active, agent_id, tool_id, allow_tools, secret')
    .eq('token', token)
    .maybeSingle()
  if (!webhook || !webhook.is_active) return json({ error: 'Unknown or inactive webhook' }, 404)

  // Optional shared-secret auth: when a secret is set, the caller must present it
  // (Authorization: Bearer <secret> or X-Webhook-Secret: <secret>). Reject early,
  // before logging an event, so a wrong/missing secret can't spam the event log.
  if (webhook.secret) {
    const provided =
      (req.headers.get('x-webhook-secret') ?? '').trim() ||
      (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    if (provided !== webhook.secret) return json({ error: 'Unauthorized' }, 401)
  }

  const raw = await req.text()
  let payload: unknown
  let payloadText: string
  try {
    payload = raw ? JSON.parse(raw) : {}
    payloadText = JSON.stringify(payload, null, 2)
  } catch {
    payload = { raw }
    payloadText = raw
  }

  const { data: event } = await db
    .from('webhook_events')
    .insert({ webhook_id: webhook.id, status: 'received', payload })
    .select('id')
    .single()
  const eventId = event?.id

  // Deterministic mode: if a tool/function is attached, call it DIRECTLY with the
  // validated payload — no model, no guardrail (schema validation is the gate).
  // Takes precedence over agent/prompt. This is the "n8n function node" path.
  if (webhook.tool_id) {
    try {
      const { data: tool } = await db
        .from('tools')
        .select('id, name, description, input_schema, kind, config, is_active')
        .eq('id', webhook.tool_id)
        .maybeSingle()
      if (!tool || !tool.is_active) {
        const msg = 'Target function is missing or inactive.'
        if (eventId) await db.from('webhook_events').update({ status: 'error', error: msg }).eq('id', eventId)
        return json({ ok: false, event_id: eventId, error: msg }, 400)
      }
      const problems = validatePayload((tool.input_schema ?? {}) as Record<string, unknown>, payload)
      if (problems.length) {
        const msg = `Payload does not match "${tool.name}" inputs: ${problems.join('; ')}`
        if (eventId) await db.from('webhook_events').update({ status: 'error', error: msg }).eq('id', eventId)
        return json({ ok: false, event_id: eventId, error: msg, fields: problems }, 400)
      }
      const result = await runHttpTool(tool as ToolRow, payload)
      if (eventId) await db.from('webhook_events').update({ status: 'ok', result }).eq('id', eventId)
      await db.from('activity_log').insert({
        type: 'webhook.function',
        summary: `Webhook "${webhook.name}" → ${tool.name}`,
        detail: { event_id: eventId, tool: tool.name },
        actor_id: webhook.owner_id,
      })
      return json({ ok: true, event_id: eventId, result })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'function call failed'
      if (eventId) await db.from('webhook_events').update({ status: 'error', error: message }).eq('id', eventId)
      return json({ ok: false, event_id: eventId, error: message }, 502)
    }
  }

  try {
    const MODEL = await resolveModel(db, 'orchestrator')

    // Guardrails: a cheap utility-model pre-flight on the untrusted payload,
    // enforced here in code. Webhooks fail CLOSED — unattended + attacker-facing.
    const guard = await runGuardrails(db, 'webhook', payloadText, webhook.owner_id)
    if (guard.ok === false && 'error' in guard) {
      if (eventId) await db.from('webhook_events').update({ status: 'blocked', error: `Guardrail evaluator error: ${guard.error}` }).eq('id', eventId)
      await db.from('activity_log').insert({ type: 'guardrail.error', summary: `Guardrail check errored for "${webhook.name}" — blocked`, detail: { event_id: eventId, error: guard.error }, actor_id: webhook.owner_id })
      return json({ ok: false, event_id: eventId, blocked: true }, 403)
    }
    if (guard.ok === false && guard.blocked) {
      const reasons = guard.violations.map((v) => `${v.name}: ${v.reason}`).join('; ')
      if (eventId) await db.from('webhook_events').update({ status: 'blocked', error: reasons }).eq('id', eventId)
      await db.from('activity_log').insert({ type: 'guardrail.blocked', summary: `Blocked "${webhook.name}" — ${guard.violations[0].name}`, detail: { event_id: eventId, violations: guard.violations }, actor_id: webhook.owner_id })
      return json({ ok: false, event_id: eventId, blocked: true }, 403)
    }
    if (guard.ok === false) {
      await db.from('activity_log').insert({ type: 'guardrail.flagged', summary: `Flagged "${webhook.name}" — ${guard.violations[0].name}`, detail: { event_id: eventId, violations: guard.violations }, actor_id: webhook.owner_id })
    }

    // Resolve what runs: an attached agent (prompt + tools) or the bare prompt.
    // Deterministic rule: the agent runs toolless unless the webhook opts in.
    let systemPrompt = webhook.prompt || 'Process the incoming webhook payload and summarize what it contains.'
    let tools: ORTool[] = []
    let httpTools = new Map<string, ToolRow>()
    let builtins = new Set<string>()
    let mcpRouter: McpRouter = new Map()
    let webEnabled = false
    if (webhook.agent_id) {
      const { data: agent } = await db.from('agents').select('instructions, tool_ids').eq('id', webhook.agent_id).maybeSingle()
      if (agent) {
        systemPrompt = agent.instructions || systemPrompt
        if (webhook.allow_tools) {
          const loaded = await loadAgentTools(db, agent.tool_ids ?? [])
          tools = loaded.tools
          httpTools = loaded.httpTools
          builtins = loaded.builtins
          mcpRouter = loaded.mcpRouter
          webEnabled = loaded.webEnabled
        }
      }
    }

    const plugins = webEnabled ? [WEB_PLUGIN] : undefined
    const reasoning = reasoningParam()
    const messages: ORMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: payloadText || '(empty payload)' },
    ]
    let result = ''
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const out = await orComplete({
        model: MODEL,
        messages,
        tools: tools.length ? tools : undefined,
        plugins,
        reasoning,
        maxTokens: 4096,
      })
      result = out.content || result
      await recordUsage(db, { context: 'webhook', model: MODEL, actorId: webhook.owner_id, agentId: webhook.agent_id, usage: out.usage })

      if (out.toolCalls.length) {
        messages.push(assistantToolCallMsg(out.content, out.toolCalls))
        for (const call of out.toolCalls) {
          const name = call.function.name
          const input = parseToolArgs(call.function.arguments)
          const tool = httpTools.get(name)
          let output: string
          if (tool) output = await runHttpTool(tool, input)
          else if (builtins.has(name)) output = await runBuiltin(db, name, input, webhook.owner_id)
          else if (mcpRouter.has(name)) output = await runMcpTool(db, mcpRouter, name, input)
          else output = `Unknown tool: ${name}`
          messages.push(toolResultMsg(call.id, output))
        }
        continue
      }
      break
    }

    if (eventId) await db.from('webhook_events').update({ status: 'ok', result }).eq('id', eventId)
    return json({ ok: true, event_id: eventId, result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'processing failed'
    if (eventId) await db.from('webhook_events').update({ status: 'error', error: message }).eq('id', eventId)
    return json({ ok: false, event_id: eventId, error: message }, 502)
  }
})
