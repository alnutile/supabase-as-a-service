// Supabase Edge Function: `event-dispatch` (PUBLIC — verify_jwt=false, gated by
// the same DB-stored cron secret the scheduler uses). Ticked every minute by
// pg_cron. It claims unprocessed `events` rows, matches each against the active
// `event_listeners`, and runs the matching listeners' actions — the "listener"
// half of the events + event-listeners feature.
//
// Actions (see 0060_events.sql):
//   run_agent         run an agent over the event (mirrors the scheduler loop)
//   run_tool          call one tool directly ({{event}} -> event JSON), no model
//   add_to_collection file the event's entity into a collection
//   log               record the run only (safe no-op / smoke test)
//
// Idempotency: each event is claimed (processed_at set) before its listeners run,
// so a listener never fires twice for the same event even if a tick overruns the
// 1-minute interval. Safety: actions are capped per tick (ACTION_BUDGET) and each
// action is isolated in try/catch. Actions that themselves create records emit
// new events (by design — automations can chain); the per-tick cap + one-time
// claim keep that bounded.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { resolveModel } from '../_shared/models.ts'
import { runBuiltin } from '../_shared/builtins.ts'
import { runHttpTool } from '../_shared/http_tool.ts'
import { expandMcpTools, runMcpTool, type McpRouter } from '../_shared/mcp.ts'
import { recordUsage } from '../_shared/usage.ts'
import { loadCollectionsContext } from '../_shared/collections.ts'
import { matchListener, substituteEvent, describeEvent, type EventRow, type ListenerRow } from '../_shared/events.ts'
import {
  assistantToolCallMsg,
  orApiKey,
  orComplete,
  parseToolArgs,
  reasoningParam,
  toolResultMsg,
  toORTool,
  WEB_SEARCH_TOOL,
  type ORMessage,
  type ORTool,
} from '../_shared/openrouter.ts'

const MAX_TOOL_TURNS = 6
const EVENT_BATCH = 100 // events claimed per tick
const ACTION_BUDGET = 30 // listener actions executed per tick (runaway backstop)

// deno-lint-ignore no-explicit-any
type DB = any

type Listener = ListenerRow & {
  id: string
  owner_id: string
  name: string
  action_type: string
  action_config: Record<string, unknown>
}

// entity_type -> the collection join table + its item id column.
const COLLECTION_JOIN: Record<string, { table: string; col: string }> = {
  artifact: { table: 'collection_artifacts', col: 'artifact_id' },
  file: { table: 'collection_files', col: 'file_id' },
  todo: { table: 'collection_todos', col: 'todo_id' },
  link: { table: 'collection_links', col: 'link_id' },
  table: { table: 'collection_tables', col: 'table_id' },
  inbox_message: { table: 'collection_inbox_messages', col: 'inbox_message_id' },
}

interface ToolRow {
  id: string
  name: string
  description: string
  input_schema: Record<string, unknown>
  kind: string
  config: { url?: string; method?: string; headers?: Record<string, string> }
}

async function loadAgentTools(db: DB, restrictIds: string[]) {
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

// Run an agent over the event — the same loop shape as the scheduler. The agent
// runs AS the listener's owner (its tools re-enforce that user's access).
async function runAgentAction(db: DB, event: EventRow, listener: Listener, model: string): Promise<string> {
  const agentId = String(listener.action_config.agent_id ?? '')
  if (!agentId) return 'Listener has no agent_id configured.'
  const { data: agent } = await db
    .from('agents')
    .select('name, instructions, tool_ids, collection_ids, is_active')
    .eq('id', agentId)
    .maybeSingle()
  if (!agent) return `Agent ${agentId} not found.`
  if (!agent.is_active) return `Agent "${agent.name}" is not active.`

  const { data: owner } = await db.from('profiles').select('email').eq('id', listener.owner_id).maybeSingle()
  const { tools, httpTools, builtins, mcpRouter, webEnabled } = await loadAgentTools(db, agent.tool_ids ?? [])
  const collCtx = await loadCollectionsContext(db, agent.collection_ids ?? [], listener.owner_id, model)
  const extra = String(listener.action_config.instructions ?? '')
  const system = [
    agent.instructions || 'You are an event-triggered agent. Handle the event described.',
    collCtx,
    [
      'You are running unattended, triggered by a workspace event. No human will read intermediate questions —',
      'decide and act with sensible defaults, do not ask for confirmation.',
      owner?.email ? `If a task needs a default email recipient, use ${owner.email}.` : '',
      'When finished, briefly summarize what you did.',
    ]
      .filter(Boolean)
      .join(' '),
  ]
    .filter(Boolean)
    .join('\n\n---\n\n')

  const userTurn = [describeEvent(event), extra && `\nInstructions: ${extra}`].filter(Boolean).join('\n')
  const messages: ORMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userTurn },
  ]
  if (webEnabled) tools.push(WEB_SEARCH_TOOL)
  const reasoning = reasoningParam()
  let result = ''
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const out = await orComplete({ model, messages, tools: tools.length ? tools : undefined, reasoning, maxTokens: 4096 })
    result = out.content || result
    await recordUsage(db, { context: 'event', model, actorId: listener.owner_id, agentId, usage: out.usage })
    if (out.toolCalls.length) {
      messages.push(assistantToolCallMsg(out.content, out.toolCalls))
      for (const call of out.toolCalls) {
        const name = call.function.name
        const args = parseToolArgs(call.function.arguments)
        const tool = httpTools.get(name)
        let res: string
        if (tool) res = await runHttpTool(db, tool, args)
        else if (builtins.has(name)) res = await runBuiltin(db, name, args, listener.owner_id)
        else if (mcpRouter.has(name)) res = await runMcpTool(db, mcpRouter, name, args)
        else res = `Unknown tool: ${name}`
        messages.push(toolResultMsg(call.id, res))
      }
      continue
    }
    break
  }
  return result || '(agent produced no output)'
}

// Run one tool directly (no model), as the listener owner. Compact mirror of
// run-tool's runOne.
async function runToolAction(db: DB, event: EventRow, listener: Listener): Promise<string> {
  const ref = String(listener.action_config.tool ?? '').trim()
  if (!ref) return 'Listener has no tool configured.'
  const rawInput = (listener.action_config.input as Record<string, unknown>) ?? {}
  const input = substituteEvent(rawInput, event)

  const { data: byName } = await db
    .from('tools')
    .select('id, name, kind, description, is_active, config')
    .eq('name', ref)
    .maybeSingle()
  let row = byName as ToolRow & { is_active: boolean } | null
  if (!row && /^[0-9a-f-]{36}$/i.test(ref)) {
    const { data: byId } = await db
      .from('tools')
      .select('id, name, kind, description, is_active, config')
      .eq('id', ref)
      .maybeSingle()
    row = byId as (ToolRow & { is_active: boolean }) | null
  }
  if (!row && ref.includes('__')) {
    const { data: mcpRows } = await db.from('tools').select('id, name, kind, config').eq('kind', 'mcp').eq('is_active', true)
    const { router } = await expandMcpTools(db, mcpRows ?? [])
    if (router.has(ref)) return await runMcpTool(db, router, ref, input)
  }
  if (!row) return `Unknown tool "${ref}".`
  if (!row.is_active) return `Tool "${ref}" is not active.`
  switch (row.kind) {
    case 'builtin':
      return await runBuiltin(db, row.name, input, listener.owner_id)
    case 'http':
      return await runHttpTool(db, row, input)
    default:
      return `Tool kind "${row.kind}" cannot be run from a listener.`
  }
}

// File the event's entity into a collection (as the listener owner), re-enforcing
// that the owner may collaborate on that collection.
async function addToCollectionAction(db: DB, event: EventRow, listener: Listener): Promise<string> {
  const collectionId = String(listener.action_config.collection_id ?? '').trim()
  if (!collectionId) return 'Listener has no collection_id configured.'
  const entityType = event.entity_type ?? ''
  const entityId = event.entity_id ?? ''
  const join = COLLECTION_JOIN[entityType]
  if (!join || !entityId) return `Event entity (${entityType || 'none'}) can't be filed into a collection.`

  const { data: col } = await db
    .from('collections')
    .select('id, name, owner_id, visibility')
    .eq('id', collectionId)
    .maybeSingle()
  if (!col) return `Collection ${collectionId} not found.`
  const { data: prof } = await db.from('profiles').select('is_admin').eq('id', listener.owner_id).maybeSingle()
  const mayWrite = col.owner_id === listener.owner_id || col.visibility === 'workspace' || Boolean(prof?.is_admin)
  if (!mayWrite) return `Not allowed to add to collection "${col.name}".`

  const { error } = await db
    .from(join.table)
    .upsert({ collection_id: collectionId, [join.col]: entityId, added_by: listener.owner_id }, {
      onConflict: `collection_id,${join.col}`,
      ignoreDuplicates: true,
    })
  if (error) return `Could not add to collection: ${error.message}`
  return `Added ${entityType} ${entityId} to collection "${col.name}".`
}

async function runAction(
  db: DB,
  event: EventRow,
  listener: Listener,
  getModel: () => Promise<string | null>,
): Promise<string> {
  switch (listener.action_type) {
    case 'log':
      return 'logged'
    case 'add_to_collection':
      return await addToCollectionAction(db, event, listener)
    case 'run_tool':
      return await runToolAction(db, event, listener)
    case 'run_agent': {
      const model = await getModel()
      if (!model) return 'OPENROUTER_API_KEY not configured — cannot run agent.'
      return await runAgentAction(db, event, listener, model)
    }
    default:
      return `Unknown action_type "${listener.action_type}".`
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Authorize with the shared cron secret (same gate as the scheduler).
  const secret = req.headers.get('x-cron-secret') ?? ''
  const { data: cfg } = await db.from('cron_config').select('secret').limit(1).maybeSingle()
  if (!cfg || secret !== cfg.secret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  // Claim a batch of unprocessed events. Claim each (set processed_at) before
  // running so a concurrent tick can't double-dispatch it.
  const { data: pending } = await db
    .from('events')
    .select('id, type, entity_type, entity_id, actor_id, summary, data, visibility')
    .is('processed_at', null)
    .order('created_at', { ascending: true })
    .limit(EVENT_BATCH)

  const claimed: EventRow[] = []
  for (const ev of pending ?? []) {
    const { data: got } = await db
      .from('events')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', ev.id)
      .is('processed_at', null)
      .select('id')
    if (got?.length) claimed.push(ev as EventRow)
  }
  if (!claimed.length) return new Response(JSON.stringify({ events: 0, actions: 0 }), { headers: { 'Content-Type': 'application/json' } })

  const { data: listeners } = await db
    .from('event_listeners')
    .select('id, owner_id, name, event_type, match, action_type, action_config')
    .eq('is_active', true)
  const active = (listeners ?? []) as Listener[]

  // Resolve the orchestrator model lazily (only run_agent needs it).
  let modelCache: string | null | undefined
  const getModel = async (): Promise<string | null> => {
    if (modelCache !== undefined) return modelCache
    modelCache = orApiKey() ? await resolveModel(db, 'orchestrator') : null
    return modelCache
  }

  let actions = 0
  for (const event of claimed) {
    for (const listener of active) {
      if (actions >= ACTION_BUDGET) break
      if (!matchListener(event, listener)) continue
      actions++
      let status = 'ok'
      let result: string | null = null
      let error: string | null = null
      try {
        result = await runAction(db, event, listener, getModel)
      } catch (e) {
        status = 'error'
        error = e instanceof Error ? e.message : 'error'
      }
      await db.from('event_listener_runs').insert({
        listener_id: listener.id,
        event_id: event.id,
        status,
        result: result ? result.slice(0, 4000) : null,
        error,
      })
      await db.from('event_listeners').update({ last_run_at: new Date().toISOString() }).eq('id', listener.id)
      await db.from('activity_log').insert({
        type: status === 'error' ? 'listener.error' : 'listener.run',
        summary: `Listener "${listener.name}" ${status === 'error' ? 'failed on' : 'handled'} ${event.type}`,
        detail: { listener_id: listener.id, event_id: event.id, action: listener.action_type, error },
        actor_id: listener.owner_id,
      })
    }
    if (actions >= ACTION_BUDGET) break
  }

  return new Response(JSON.stringify({ events: claimed.length, actions }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
