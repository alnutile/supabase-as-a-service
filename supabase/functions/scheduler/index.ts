// Supabase Edge Function: `scheduler` (PUBLIC — verify_jwt=false, but gated by a
// DB-stored secret that only the pg_cron job knows). Called every minute by
// pg_cron; runs any agents whose schedule is due, over the schedule's input.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { resolveModel } from '../_shared/models.ts'
import { runBuiltin } from '../_shared/builtins.ts'
import { expandMcpTools, runMcpTool, type McpRouter } from '../_shared/mcp.ts'
import { recordUsage } from '../_shared/usage.ts'
import { loadCollectionsContext } from '../_shared/collections.ts'
import { runHttpTool } from '../_shared/http_tool.ts'
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

interface ToolRow {
  id: string
  name: string
  description: string
  input_schema: Record<string, unknown>
  kind: string
  config: { url?: string; method?: string; headers?: Record<string, string> }
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

// Scheduled runs are unattended: no human sees the agent's questions or answers
// them, so an agent that pauses to ask "who should I email?" stalls forever.
// This preamble tells the agent to decide and act, and supplies the owner's
// email as the default recipient when the task needs one and none was given.
function scheduledRunGuidance(ownerEmail: string | null): string {
  return [
    'You are running as an unattended, scheduled background job.',
    'No human will read intermediate questions or reply to you, so do NOT ask clarifying questions or wait for confirmation — decide and act, completing the task end to end with sensible defaults.',
    ownerEmail
      ? `If the task involves sending email and no recipient is specified, send it to ${ownerEmail}.`
      : 'If a task is missing information, choose a reasonable default rather than asking.',
    'When finished, briefly summarize what you did.',
  ].join(' ')
}

// deno-lint-ignore no-explicit-any
async function runAgent(db: any, agent: { instructions: string; tool_ids: string[]; collection_ids?: string[] }, input: string, model: string, ownerId: string | null, ownerEmail: string | null, agentId: string | null) {
  const { tools, httpTools, builtins, mcpRouter, webEnabled } = await loadAgentTools(db, agent.tool_ids ?? [])
  // Inject the agent's bound collections (artifacts/files/to-dos) as context.
  const collCtx = await loadCollectionsContext(db, agent.collection_ids ?? [], ownerId, model)
  const system = [
    agent.instructions || 'You are a scheduled agent. Do the task described.',
    collCtx,
    scheduledRunGuidance(ownerEmail),
  ]
    .filter(Boolean)
    .join('\n\n---\n\n')
  // The schedule's input is optional. When it's blank, drive the agent with a
  // clear directive so it runs its own instructions (the system prompt) rather
  // than being handed a meaningless turn.
  const messages: ORMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: input.trim() || "It's time for your scheduled run. Carry out your task now, following your instructions." },
  ]
  const plugins = webEnabled ? [WEB_PLUGIN] : undefined
  const reasoning = reasoningParam()
  let result = ''
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const out = await orComplete({
      model,
      messages,
      tools: tools.length ? tools : undefined,
      plugins,
      reasoning,
      maxTokens: 4096,
    })
    result = out.content || result
    await recordUsage(db, { context: 'scheduler', model, actorId: ownerId, agentId, usage: out.usage })
    if (out.toolCalls.length) {
      messages.push(assistantToolCallMsg(out.content, out.toolCalls))
      for (const call of out.toolCalls) {
        const name = call.function.name
        const input = parseToolArgs(call.function.arguments)
        const tool = httpTools.get(name)
        let res: string
        if (tool) res = await runHttpTool(db, tool, input)
        else if (builtins.has(name)) res = await runBuiltin(db, name, input, ownerId)
        else if (mcpRouter.has(name)) res = await runMcpTool(db, mcpRouter, name, input)
        else res = `Unknown tool: ${name}`
        messages.push(toolResultMsg(call.id, res))
      }
      continue
    }
    break
  }
  return result
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Authorize: the cron job sends the shared DB secret.
  const secret = req.headers.get('x-cron-secret') ?? ''
  const { data: cfg } = await db.from('cron_config').select('secret').limit(1).maybeSingle()
  if (!cfg || secret !== cfg.secret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  const { data: due } = await db
    .from('schedules')
    .select('id, owner_id, agent_id, input, interval_minutes')
    .eq('is_active', true)
    .lte('next_run_at', new Date().toISOString())
    .limit(20)

  if (!orApiKey()) return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY not configured' }), { status: 500 })
  const model = await resolveModel(db, 'orchestrator')
  let ran = 0

  for (const s of due ?? []) {
    // Claim the row before running: advance next_run_at only if it is still due.
    // A concurrent tick (runs often outlast the 1-minute cron interval) loses the
    // conditional update and skips, so a schedule can never double-fire.
    const now = new Date()
    const next = new Date(now.getTime() + s.interval_minutes * 60_000).toISOString()
    const { data: claimed } = await db
      .from('schedules')
      .update({ last_run_at: now.toISOString(), next_run_at: next })
      .eq('id', s.id)
      .lte('next_run_at', now.toISOString())
      .select('id')
    if (!claimed?.length) continue
    try {
      const { data: agent } = await db.from('agents').select('name, instructions, tool_ids, collection_ids, is_active').eq('id', s.agent_id).maybeSingle()
      if (agent && agent.is_active) {
        const { data: owner } = await db.from('profiles').select('email').eq('id', s.owner_id).maybeSingle()
        const result = await runAgent(db, agent, s.input, model, s.owner_id, owner?.email ?? null, s.agent_id)
        await db.from('activity_log').insert({
          type: 'schedule.run',
          summary: `Ran agent ${agent.name} (scheduled)`,
          detail: { schedule_id: s.id, result: result.slice(0, 2000) },
          actor_id: s.owner_id,
        })
        ran++
      }
    } catch (err) {
      await db.from('activity_log').insert({
        type: 'schedule.error',
        summary: 'Scheduled run failed',
        detail: { schedule_id: s.id, error: err instanceof Error ? err.message : 'error' },
        actor_id: s.owner_id,
      })
    }
  }

  return new Response(JSON.stringify({ ran }), { headers: { 'Content-Type': 'application/json' } })
})
