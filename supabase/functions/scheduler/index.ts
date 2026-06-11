// Supabase Edge Function: `scheduler` (PUBLIC — verify_jwt=false, but gated by a
// DB-stored secret that only the pg_cron job knows). Called every minute by
// pg_cron; runs any agents whose schedule is due, over the schedule's input.
import Anthropic from 'npm:@anthropic-ai/sdk@0.69.0'
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { resolveModel } from '../_shared/models.ts'
import { runBuiltin } from '../_shared/builtins.ts'

const EFFORT = (Deno.env.get('ANTHROPIC_EFFORT') ?? 'medium') as 'low' | 'medium' | 'high'
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
  const anthropicTools: unknown[] = []
  const httpTools = new Map<string, ToolRow>()
  const builtins = new Set<string>()
  if (!restrictIds.length) return { anthropicTools, httpTools, builtins }
  const { data } = await db.from('tools').select('*').eq('is_active', true)
  let web = false
  for (const t of (data ?? []) as ToolRow[]) {
    if (!restrictIds.includes(t.id)) continue
    if (t.kind === 'web') web = true
    else if (t.kind === 'builtin' && t.name) {
      anthropicTools.push({ name: t.name, description: t.description, input_schema: t.input_schema ?? { type: 'object', properties: {} } })
      builtins.add(t.name)
    } else if (t.kind === 'http' && t.name) {
      anthropicTools.push({ name: t.name, description: t.description, input_schema: t.input_schema ?? { type: 'object', properties: {} } })
      httpTools.set(t.name, t)
    }
  }
  if (web) {
    anthropicTools.push({ type: 'web_search_20260209', name: 'web_search' })
    anthropicTools.push({ type: 'web_fetch_20260209', name: 'web_fetch' })
  }
  return { anthropicTools, httpTools, builtins }
}

async function runHttpTool(tool: ToolRow, input: unknown): Promise<string> {
  const u = tool.config?.url
  if (!u) return 'Tool is misconfigured: no url.'
  try {
    const res = await fetch(u, {
      method: tool.config?.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...(tool.config?.headers ?? {}) },
      body: JSON.stringify(input ?? {}),
    })
    return (await res.text()).slice(0, 50000)
  } catch (err) {
    return `Tool call failed: ${err instanceof Error ? err.message : 'error'}`
  }
}

function textOf(content: Array<Record<string, unknown>>): string {
  return content.filter((b) => b.type === 'text').map((b) => b.text as string).join('\n').trim()
}

// deno-lint-ignore no-explicit-any
async function runAgent(anthropic: Anthropic, db: any, agent: { instructions: string; tool_ids: string[] }, input: string, model: string, ownerId: string | null) {
  const { anthropicTools, httpTools, builtins } = await loadAgentTools(db, agent.tool_ids ?? [])
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: input || '(scheduled run)' },
  ]
  let result = ''
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      system: agent.instructions || 'You are a scheduled agent. Do the task described.',
      tools: anthropicTools.length ? (anthropicTools as never) : undefined,
      messages: messages as never,
    })
    messages.push({ role: 'assistant', content: msg.content })
    result = textOf(msg.content as Array<Record<string, unknown>>) || result
    if (msg.stop_reason === 'tool_use') {
      const toolResults: unknown[] = []
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_use') continue
        const name = block.name as string
        const tool = httpTools.get(name)
        let out: string
        if (tool) out = await runHttpTool(tool, block.input)
        else if (builtins.has(name)) out = await runBuiltin(db, name, (block.input as Record<string, unknown>) ?? {}, ownerId)
        else out = `Unknown tool: ${name}`
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out })
      }
      messages.push({ role: 'user', content: toolResults })
      continue
    }
    if (msg.stop_reason === 'pause_turn') continue
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

  const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })
  const model = await resolveModel(db, 'orchestrator')
  let ran = 0

  for (const s of due ?? []) {
    const next = new Date(Date.now() + s.interval_minutes * 60_000).toISOString()
    try {
      const { data: agent } = await db.from('agents').select('name, instructions, tool_ids, is_active').eq('id', s.agent_id).maybeSingle()
      if (agent && agent.is_active) {
        const result = await runAgent(anthropic, db, agent, s.input, model, s.owner_id)
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
    await db.from('schedules').update({ last_run_at: new Date().toISOString(), next_run_at: next }).eq('id', s.id)
  }

  return new Response(JSON.stringify({ ran }), { headers: { 'Content-Type': 'application/json' } })
})
