// Supabase Edge Function: `loop` (verify_jwt=true).
//
// Drives a goal-directed agent run — a closed feedback loop after the COMPILOT
// pattern (arXiv:2511.00592). Each iteration the agent proposes ONE candidate
// for the loop's goal; a feedback source scores it 0–100; the score + the running
// dialogue feed the next iteration; the best-scoring candidate is kept. The run
// stops the moment ANY criterion fires:
//   • budget         — cumulative model cost ≥ budget_usd (a hard per-run cap)
//   • max_iterations — iteration cap reached
//   • converged      — the agent calls the `loop_done` tool
//   • target_reached — best score ≥ target_score
//
// The budget gate is FAIL-CLOSED: it's checked before every model call, and a
// call whose cost OpenRouter can't report counts as a configurable worst-case so
// a loop can never iterate with an unknown, unbounded cost.
//
// Feedback source: the loop's `feedback_tool_id` http tool (POST {goal, candidate}
// → {score, detail}), or — when none is set — a utility-model judge graded
// against the loop's rubric. Reuses the shared agent machinery (tools, builtins,
// usage accounting) so a loop run behaves like any other orchestrator run.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { resolveModel } from '../_shared/models.ts'
import { runBuiltin } from '../_shared/builtins.ts'
import { runHttpTool } from '../_shared/http_tool.ts'
import { runJudge } from '../_shared/judge.ts'
import { runGuardrails } from '../_shared/guardrails.ts'
import { recordUsage } from '../_shared/usage.ts'
import {
  assistantToolCallMsg,
  orApiKey,
  orComplete,
  parseToolArgs,
  reasoningParam,
  systemMsg,
  toolResultMsg,
  toORTool,
  WEB_SEARCH_TOOL,
  type ORMessage,
  type ORTool,
} from '../_shared/openrouter.ts'

// Tool turns allowed WITHIN a single iteration (so the agent can search/compute
// before settling on its candidate). The outer loop count is loops.max_iterations.
const MAX_TOOL_TURNS = 8
// Worst-case cost charged against the budget when OpenRouter doesn't report a
// call's price — keeps the fail-closed gate honest without a real number.
const UNKNOWN_CALL_COST = 0.05
const PREVIEW_LEN = 400

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function userIdFromAuth(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof claims.sub === 'string' ? claims.sub : null
  } catch {
    return null
  }
}

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

// loop_done is a synthetic tool the agent calls to signal convergence. It's not a
// real `tools` row — the runner injects it so "done" is an explicit, parseable
// action (the loop's analogue of COMPILOT's no_further_transformations command).
const LOOP_DONE: ORTool = toORTool(
  'loop_done',
  'Call this when you cannot meaningfully improve your candidate further. It ends the loop and keeps the best-scoring candidate so far.',
  { type: 'object', properties: {} },
)

async function loadAgentTools(db: DB, restrictIds: string[]) {
  const tools: ORTool[] = []
  const httpTools = new Map<string, ToolRow>()
  const builtins = new Set<string>()
  let webEnabled = false
  if (restrictIds.length) {
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
      }
    }
  }
  return { tools, httpTools, builtins, webEnabled }
}

function buildSystem(instructions: string, goal: string): string {
  return [
    instructions?.trim() || 'You are a capable agent working toward a goal.',
    `# Your goal\n${goal}`,
    `# How this loop works
You are running inside an optimization loop. Each round, produce your single best candidate that satisfies the goal — output ONLY the deliverable itself, with no preamble or commentary about the loop. An evaluator then scores your candidate from 0 to 100 and gives feedback. Use that feedback to produce a strictly better candidate next round. The best-scoring candidate across all rounds is what gets kept. When you genuinely cannot improve the score further, call the loop_done tool to finish instead of repeating yourself.`,
  ].join('\n\n')
}

function feedbackMessage(score: number, detail: string): string {
  return [
    `Your last candidate scored ${score}/100.`,
    detail ? `Evaluator feedback: ${detail}` : '',
    'Produce an improved candidate that would score higher. If you truly cannot do better, call the loop_done tool.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

interface TurnResult {
  text: string
  converged: boolean
  cost: number
  toolsUsed: string[]
}

// One iteration: run the model + its tools (mutating `messages`) until it emits a
// final candidate with no tool calls, or calls loop_done. Stops early if the
// budget is exhausted mid-iteration.
async function produceCandidate(
  db: DB,
  messages: ORMessage[],
  model: string,
  tools: ORTool[],
  httpTools: Map<string, ToolRow>,
  builtins: Set<string>,
  userId: string | null,
  agentId: string | null,
  remainingBudget: () => number,
): Promise<TurnResult> {
  const reasoning = reasoningParam()
  const allTools = [...tools, LOOP_DONE]
  const toolsUsed: string[] = []
  let text = ''
  let cost = 0

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    if (remainingBudget() - cost <= 0) break
    const out = await orComplete({ model, messages, tools: allTools, reasoning, maxTokens: 8000 })
    cost += out.usage?.cost ?? UNKNOWN_CALL_COST
    await recordUsage(db, { context: 'loop', model, actorId: userId, agentId, usage: out.usage })
    if (out.content) text = out.content

    if (out.toolCalls.length) {
      messages.push(assistantToolCallMsg(out.content, out.toolCalls))
      let converged = false
      for (const call of out.toolCalls) {
        const name = call.function.name
        if (name === 'loop_done') {
          converged = true
          messages.push(toolResultMsg(call.id, 'Acknowledged — ending the loop.'))
          continue
        }
        const input = parseToolArgs(call.function.arguments)
        const tool = httpTools.get(name)
        let res: string
        if (tool) res = await runHttpTool(db, tool, input)
        else if (builtins.has(name)) res = await runBuiltin(db, name, input, userId)
        else res = `Unknown tool: ${name}`
        toolsUsed.push(name)
        messages.push(toolResultMsg(call.id, res))
      }
      if (converged) return { text, converged: true, cost, toolsUsed }
      continue
    }

    // Final candidate — record the assistant turn so the next feedback message
    // follows it in the dialogue.
    messages.push({ role: 'assistant', content: out.content || '' })
    return { text, converged: false, cost, toolsUsed }
  }
  return { text, converged: false, cost, toolsUsed }
}

interface Score {
  score: number // 0–100
  detail: string
  cost: number
}

// Normalize a feedback http tool's response to a 0–100 score + a detail string.
// Accepts {score, detail} where score is 0–1 (treated as a fraction) or 0–100.
function parseToolScore(body: string): Score {
  try {
    const obj = JSON.parse(body)
    let s = Number(obj.score ?? obj.rating ?? 0)
    if (!Number.isFinite(s)) s = 0
    if (s <= 1) s = s * 100
    s = Math.max(0, Math.min(100, Math.round(s)))
    const detail = String(obj.detail ?? obj.reason ?? obj.feedback ?? '').slice(0, 2000)
    return { score: s, detail, cost: 0 }
  } catch {
    return { score: 0, detail: `Could not parse feedback tool response: ${body.slice(0, 300)}`, cost: 0 }
  }
}

async function scoreCandidate(
  db: DB,
  candidate: string,
  loop: { goal: string; rubric: string; feedback_tool_id: string | null },
  feedbackTool: ToolRow | null,
  userId: string | null,
  agentId: string | null,
): Promise<Score> {
  if (feedbackTool) {
    const body = await runHttpTool(db, feedbackTool, { goal: loop.goal, candidate, output: candidate })
    return parseToolScore(body)
  }
  // Default: a utility-model judge graded against the loop's rubric (or, with no
  // rubric, on how well the candidate satisfies the goal).
  const v = await runJudge(db, {
    question: loop.goal,
    output: candidate,
    rubric: loop.rubric || `Score how well the ACTUAL answer satisfies this goal: "${loop.goal}". Reward completeness, accuracy, and quality.`,
  })
  const model = await resolveModel(db, 'utility')
  await recordUsage(db, {
    context: 'loop',
    model,
    actorId: userId,
    agentId,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: v.cost, reasoningTokens: 0, cachedTokens: 0, raw: {} },
  })
  return { score: Math.round(v.score * 100), detail: v.reason, cost: v.cost }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!orApiKey()) return json({ error: 'OPENROUTER_API_KEY is not configured' }, 500)

  let loopId: string
  let bodyTriggeredBy = ''
  try {
    const body = await req.json()
    loopId = String(body.loop_id ?? body.loopId ?? '')
    if (typeof body.triggered_by === 'string') bodyTriggeredBy = body.triggered_by
    if (!loopId) throw new Error('`loop_id` is required')
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Bad request' }, 400)
  }

  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return json({ error: 'server not configured' }, 500)
  const db = createClient(url, key)
  // A real user JWT carries `sub`, so it wins. Internal callers (the MCP server /
  // in-app builtins) reach this with the service-role key — no `sub` — and pass
  // the acting user explicitly so the run is attributed correctly. A member can't
  // spoof another user because their own `sub` always takes precedence.
  const userId = userIdFromAuth(req) ?? (bodyTriggeredBy || null)

  const { data: loop } = await db
    .from('loops')
    .select('id, owner_id, name, goal, agent_id, feedback_tool_id, rubric, max_iterations, budget_usd, target_score, is_active')
    .eq('id', loopId)
    .maybeSingle()
  if (!loop) return json({ error: 'loop not found' }, 404)
  if (!loop.is_active) return json({ error: 'loop is inactive' }, 400)

  const { data: agent } = await db
    .from('agents')
    .select('name, instructions, tool_ids, is_active')
    .eq('id', loop.agent_id)
    .maybeSingle()
  if (!agent || agent.is_active === false) return json({ error: 'loop agent is missing or inactive' }, 400)

  // Pre-flight guardrails on the goal (chat context — fails open for a signed-in
  // member). A block stops before any run row is created.
  try {
    const guard = await runGuardrails(db, 'chat', loop.goal ?? '', userId)
    if (guard.ok === false && 'blocked' in guard && guard.blocked) {
      await db.from('activity_log').insert({
        type: 'guardrail.blocked',
        summary: `Blocked loop "${loop.name}" — ${guard.violations[0]?.name ?? 'guardrail'}`,
        detail: { loop_id: loop.id },
        actor_id: userId,
      })
      return json({ error: `Blocked by workspace guardrail: ${guard.violations[0]?.name ?? 'guardrail'}` }, 403)
    }
  } catch {
    // fail open
  }

  const feedbackTool: ToolRow | null = loop.feedback_tool_id
    ? ((await db.from('tools').select('*').eq('id', loop.feedback_tool_id).maybeSingle()).data as ToolRow | null)
    : null

  const { data: run } = await db
    .from('loop_runs')
    .insert({ loop_id: loop.id, status: 'running', triggered_by: userId })
    .select('id')
    .single()
  const runId = run!.id as string

  // Run the loop OUTSIDE the request so we don't hit the 150s request idle
  // timeout: respond immediately with the run id and let it stream progress to
  // loop_runs (the UI subscribes over Realtime). EdgeRuntime.waitUntil keeps the
  // worker alive for the background task; the loop self-stops before the
  // wall-clock limit so a run always finalizes (see runLoop / WALL_CLOCK_MS).
  const task = runLoop(db, { loop, agent, feedbackTool, userId, runId })
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime
  if (er && typeof er.waitUntil === 'function') er.waitUntil(task)
  else await task // local/dev without background-task support
  return json({ run_id: runId, status: 'running' }, 202)
})

interface RunParams {
  // deno-lint-ignore no-explicit-any
  loop: any
  // deno-lint-ignore no-explicit-any
  agent: any
  feedbackTool: ToolRow | null
  userId: string | null
  runId: string
}

// In-flight runs, so a worker shutdown (beforeunload) can finalize them instead
// of leaving the row stuck on 'running' forever.
interface ActiveRun {
  db: DB
  runId: string
  finalized: { done: boolean }
  // deno-lint-ignore no-explicit-any
  snapshot: () => { costSpent: number; bestScore: number; bestOutput: string; transcript: any[] }
}
const ACTIVE = new Set<ActiveRun>()

addEventListener('beforeunload', () => {
  for (const a of ACTIVE) {
    if (a.finalized.done) continue
    a.finalized.done = true
    const s = a.snapshot()
    // Best-effort during shutdown — the in-loop wall-clock self-stop is the
    // primary guarantee; this just catches a worker retired early.
    a.db
      .from('loop_runs')
      .update({
        status: 'done',
        stop_reason: 'time',
        iterations: s.transcript.length,
        cost_spent: s.costSpent,
        best_score: s.bestScore < 0 ? null : s.bestScore,
        best_output: s.bestOutput || null,
        transcript: s.transcript,
        ended_at: new Date().toISOString(),
      })
      .eq('id', a.runId)
  }
})

// Stop a loop this many ms in, before the platform wall-clock limit (150s free /
// 400s paid) would kill the worker. Override with LOOP_MAX_WALL_MS (raise on paid
// plans). The run then finalizes cleanly with stop_reason 'time'.
const WALL_CLOCK_MS = Number(Deno.env.get('LOOP_MAX_WALL_MS') ?? 130_000)

async function runLoop(db: DB, { loop, agent, feedbackTool, userId, runId }: RunParams) {
  const startedAt = Date.now()
  const model = await resolveModel(db, 'orchestrator')
  const { tools, httpTools, builtins, webEnabled } = await loadAgentTools(db, agent.tool_ids ?? [])
  if (webEnabled) tools.push(WEB_SEARCH_TOOL)

  const budget = Number(loop.budget_usd)
  const maxIter = Number(loop.max_iterations)
  const target = loop.target_score == null ? null : Number(loop.target_score)

  const messages: ORMessage[] = [
    systemMsg(buildSystem(agent.instructions ?? '', loop.goal ?? '')),
    { role: 'user', content: 'Produce your first candidate for the goal now.' },
  ]

  // deno-lint-ignore no-explicit-any
  const transcript: any[] = []
  let costSpent = 0
  let bestScore = -1
  let bestOutput = ''
  let stopReason: 'budget' | 'max_iterations' | 'converged' | 'target_reached' | 'time' | 'error' = 'max_iterations'

  const active: ActiveRun = {
    db,
    runId,
    finalized: { done: false },
    snapshot: () => ({ costSpent, bestScore, bestOutput, transcript }),
  }
  ACTIVE.add(active)
  const outOfTime = () => Date.now() - startedAt > WALL_CLOCK_MS

  async function persist(status: 'running' | 'done' | 'error', extra: Record<string, unknown> = {}) {
    await db
      .from('loop_runs')
      .update({
        status,
        iterations: transcript.length,
        cost_spent: costSpent,
        best_score: bestScore < 0 ? null : bestScore,
        best_output: bestOutput || null,
        transcript,
        ...extra,
      })
      .eq('id', runId)
  }

  try {
    for (let iter = 1; iter <= maxIter; iter++) {
      // Budget gate — fail-closed, checked before spending on this iteration.
      if (costSpent >= budget) {
        stopReason = 'budget'
        break
      }
      // Wall-clock gate — stop before the platform kills the worker, so the run
      // finalizes cleanly with the best result so far.
      if (outOfTime()) {
        stopReason = 'time'
        break
      }

      const turn = await produceCandidate(
        db, messages, model, tools, httpTools, builtins, userId, loop.agent_id, () => budget - costSpent,
      )
      costSpent += turn.cost

      const candidate = turn.text.trim()
      // Nothing new to score (agent gave up immediately) → keep prior best.
      if (!candidate) {
        if (turn.converged) {
          stopReason = 'converged'
          break
        }
        // No output and not converged — treat as a stall.
        stopReason = 'converged'
        break
      }

      // Out of budget after generating? Record the candidate, then stop without
      // paying for another scoring call.
      if (costSpent >= budget) {
        if (bestScore < 0) {
          bestScore = 0
          bestOutput = candidate
        }
        transcript.push({ iteration: iter, score: null, detail: 'Budget reached before scoring.', cost_spent: round(costSpent), preview: candidate.slice(0, PREVIEW_LEN), tools_used: turn.toolsUsed })
        stopReason = 'budget'
        await persist('running')
        break
      }

      const sc = await scoreCandidate(db, candidate, loop, feedbackTool, userId, loop.agent_id)
      costSpent += sc.cost
      if (sc.score > bestScore) {
        bestScore = sc.score
        bestOutput = candidate
      }
      transcript.push({ iteration: iter, score: sc.score, detail: sc.detail, cost_spent: round(costSpent), preview: candidate.slice(0, PREVIEW_LEN), tools_used: turn.toolsUsed })
      await persist('running')

      if (turn.converged) {
        stopReason = 'converged'
        break
      }
      if (target != null && bestScore >= target) {
        stopReason = 'target_reached'
        break
      }
      if (iter >= maxIter) {
        stopReason = 'max_iterations'
        break
      }
      if (costSpent >= budget) {
        stopReason = 'budget'
        break
      }
      if (outOfTime()) {
        stopReason = 'time'
        break
      }

      messages.push({ role: 'user', content: feedbackMessage(sc.score, sc.detail) })
    }

    active.finalized.done = true
    await persist('done', { stop_reason: stopReason, ended_at: new Date().toISOString() })
    const phrase = stopReason === 'budget' ? 'hit its budget' : stopReason === 'time' ? 'stopped at the time limit' : 'finished'
    await db.from('activity_log').insert({
      type: stopReason === 'budget' ? 'loop.budget_capped' : 'loop.completed',
      summary: `Loop "${loop.name}" ${phrase} — best ${bestScore < 0 ? 'n/a' : bestScore + '/100'} in ${transcript.length} iteration(s)`,
      detail: { loop_id: loop.id, run_id: runId, stop_reason: stopReason, cost_spent: round(costSpent), best_score: bestScore < 0 ? null : bestScore },
      actor_id: userId,
    })
  } catch (err) {
    active.finalized.done = true
    const message = err instanceof Error ? err.message : 'loop failed'
    await persist('error', { stop_reason: 'error', error: message, ended_at: new Date().toISOString() })
    await db.from('activity_log').insert({
      type: 'loop.error',
      summary: `Loop "${loop.name}" errored`,
      detail: { loop_id: loop.id, run_id: runId, error: message },
      actor_id: userId,
    })
  } finally {
    ACTIVE.delete(active)
  }
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000
}
