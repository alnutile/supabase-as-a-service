// Non-streaming orchestrator — the eval-time sibling of the chat function's
// agentic loop. Given a question (+ optional agent system/tools), it runs the
// SAME pipeline a real chat turn would: always-on system prompts, the active
// tools (web plugin + http tools + builtins like search_documents), and the
// model tool-loop — but with orComplete (no SSE) so a caller can score the final
// answer. Kept separate from chat/index.ts (which streams) to avoid touching the
// live path; the two loops are intentionally identical and could be unified later.
//
// Eval costs are summed and returned (for eval_runs.cost) rather than written to
// usage_events, so running evals never pollutes production spend stats.
import { resolveModel } from './models.ts'
import { runBuiltin } from './builtins.ts'
import {
  assistantToolCallMsg,
  orComplete,
  parseToolArgs,
  reasoningParam,
  systemMsg,
  toolResultMsg,
  toORTool,
  WEB_PLUGIN,
  type ORMessage,
  type ORTool,
} from './openrouter.ts'

const MAX_TOOL_TURNS = 6

const DEFAULT_SYSTEM = `You are the assistant inside a Supabase-powered intranet. Be warm, concise, and practical.`

// deno-lint-ignore no-explicit-any
type DB = any

interface ToolRow {
  id: string
  name: string
  description: string
  input_schema: Record<string, unknown>
  kind: string
  config: { url?: string; method?: string; headers?: Record<string, string> }
}

async function loadAlwaysOnSystem(db: DB): Promise<string> {
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

async function loadTools(db: DB, restrictIds?: string[] | null) {
  const tools: ORTool[] = []
  const httpTools = new Map<string, ToolRow>()
  const builtins = new Set<string>()
  let webEnabled = false
  try {
    const { data } = await db.from('tools').select('*').eq('is_active', true)
    for (const t of (data ?? []) as ToolRow[]) {
      if (restrictIds && !restrictIds.includes(t.id)) continue
      if (t.kind === 'web') webEnabled = true
      else if (t.kind === 'builtin' && t.name) {
        tools.push(toORTool(t.name, t.description, t.input_schema))
        builtins.add(t.name)
      } else if (t.kind === 'http' && t.name) {
        tools.push(toORTool(t.name, t.description, t.input_schema))
        httpTools.set(t.name, t)
      }
    }
  } catch {
    // tools optional
  }
  return { tools, httpTools, builtins, webEnabled }
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
    return (await res.text()).slice(0, 50000) || `(empty response, status ${res.status})`
  } catch (err) {
    return `Tool call failed: ${err instanceof Error ? err.message : 'unknown error'}`
  }
}

export interface OrchestratorResult {
  text: string
  cost: number
  toolsUsed: string[]
}

// Answer one question through the full pipeline. `system` (an agent's
// instructions) replaces the always-on prompts when provided; `toolIds` scopes
// the toolset (an agent's tools). `model` overrides the orchestrator profile —
// that's what powers the model-swap comparison.
export async function runOrchestrator(
  db: DB,
  opts: { question: string; system?: string | null; toolIds?: string[] | null; model?: string | null; userId?: string | null },
): Promise<OrchestratorResult> {
  const model = opts.model || (await resolveModel(db, 'orchestrator'))
  const { tools, httpTools, builtins, webEnabled } = await loadTools(db, opts.toolIds)
  const system = (opts.system && opts.system.trim()) ? opts.system : await loadAlwaysOnSystem(db)

  const messages: ORMessage[] = [systemMsg(system), { role: 'user', content: opts.question }]
  const plugins = webEnabled ? [WEB_PLUGIN] : undefined
  const reasoning = reasoningParam()
  const toolsUsed: string[] = []
  let cost = 0
  let finalText = ''

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const result = await orComplete({
      model,
      messages,
      tools: tools.length ? tools : undefined,
      plugins,
      reasoning,
      maxTokens: 4000,
    })
    cost += result.usage?.cost ?? 0
    if (result.content) finalText = result.content

    if (result.toolCalls.length) {
      messages.push(assistantToolCallMsg(result.content, result.toolCalls))
      for (const call of result.toolCalls) {
        const name = call.function.name
        const input = parseToolArgs(call.function.arguments)
        const tool = httpTools.get(name)
        let output: string
        if (tool) output = await runHttpTool(tool, input)
        else if (builtins.has(name)) output = await runBuiltin(db, name, input, opts.userId ?? null)
        else output = `Unknown tool: ${name}`
        toolsUsed.push(name)
        messages.push(toolResultMsg(call.id, output))
      }
      continue
    }
    break
  }

  return { text: finalText, cost, toolsUsed }
}
