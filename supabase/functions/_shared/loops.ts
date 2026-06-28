// Shared helpers for the looping system — the COMPILOT-style goal-directed runs
// driven by the `loop` edge function (propose a candidate → score it 0–100 →
// feed the score back → keep the best, stopping at a budget / iteration / target
// / convergence). These helpers let BOTH entry points spin a loop up through one
// code path so they never drift:
//   • the MCP server (an external Claude): create_loop / run_loop / get_loop_run
//   • the in-app builtins (chat / scheduler / webhook agents): start_loop / check_loop
//
// "Send it a prompt + a rubric, iterate at this budget, then check on it" is the
// whole shape — create a `loops` row, fire the `loop` function (which runs in the
// background and streams to `loop_runs`), then poll a run for progress + the best
// result so far.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

// deno-lint-ignore no-explicit-any
type DB = any

// A per-owner agent every ad-hoc loop falls back to when no agent is named, so a
// caller can run a pure prompt+rubric loop without first wiring up an agent. It
// carries no tools — the loop's own system prompt supplies sensible defaults.
const DEFAULT_LOOP_AGENT = 'Loop runner'

// A sane upper bound on a single run's budget so a model can't fat-finger a huge
// number; the loops table only constrains budget_usd > 0.
const MAX_BUDGET_USD = 100

// Clamp the knobs to the loops table's CHECK constraints (max_iterations 1–50,
// budget_usd > 0, target_score 0–100) so a stray value surfaces as a sensible
// default instead of a DB error.
function clampIterations(n: unknown): number {
  const v = Math.trunc(Number(n))
  if (!Number.isFinite(v)) return 10
  return Math.max(1, Math.min(50, v))
}
function clampBudget(n: unknown): number {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return 1
  return Math.min(v, MAX_BUDGET_USD)
}
function clampTarget(n: unknown): number | null {
  if (n == null || n === '') return null
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  return Math.max(0, Math.min(100, v))
}

// Find (or lazily create) the owner's default loop agent.
export async function findOrCreateLoopAgent(db: DB, owner: string): Promise<string> {
  const { data: existing } = await db
    .from('agents')
    .select('id')
    .eq('owner_id', owner)
    .eq('name', DEFAULT_LOOP_AGENT)
    .maybeSingle()
  if (existing?.id) return existing.id as string
  const { data: created, error } = await db
    .from('agents')
    .insert({
      owner_id: owner,
      name: DEFAULT_LOOP_AGENT,
      description: 'Default agent used by loops started from MCP or the assistant.',
      instructions: '',
      tool_ids: [],
    })
    .select('id')
    .single()
  if (error || !created) throw new Error(`could not provision a loop agent: ${error?.message ?? 'unknown error'}`)
  return created.id as string
}

// Resolve an agent by id or name (active agents only). Returns null when not found.
export async function resolveAgent(db: DB, ref: string | undefined | null): Promise<string | null> {
  const r = String(ref ?? '').trim()
  if (!r) return null
  const { data } = await db.from('agents').select('id, name').eq('is_active', true)
  const found = (data ?? []).find(
    (a: { id: string; name: string }) => a.id === r || a.name.trim().toLowerCase() === r.toLowerCase(),
  )
  return found ? found.id : null
}

// Resolve an http tool (a loop feedback source) by id or name. Returns null when
// not found.
export async function resolveFeedbackTool(db: DB, ref: string | undefined | null): Promise<string | null> {
  const r = String(ref ?? '').trim()
  if (!r) return null
  const { data } = await db.from('tools').select('id, name').eq('kind', 'http')
  const found = (data ?? []).find(
    (t: { id: string; name: string | null }) => t.id === r || (t.name ?? '').trim().toLowerCase() === r.toLowerCase(),
  )
  return found ? found.id : null
}

export interface LoopSpec {
  name?: unknown
  goal: string
  rubric?: unknown
  max_iterations?: unknown
  budget_usd?: unknown
  target_score?: unknown
  agent_id: string
  feedback_tool_id?: string | null
}

// Create a `loops` row (the reusable config). Throws on a bad goal / DB error.
export async function createLoop(db: DB, owner: string, spec: LoopSpec): Promise<{ id: string; name: string }> {
  const goal = String(spec.goal ?? '').trim()
  if (!goal) throw new Error('a goal is required — the prompt the loop optimizes toward')
  const name = String(spec.name ?? '').trim() || goal.slice(0, 60)
  const { data, error } = await db
    .from('loops')
    .insert({
      owner_id: owner,
      name,
      goal,
      rubric: String(spec.rubric ?? ''),
      agent_id: spec.agent_id,
      feedback_tool_id: spec.feedback_tool_id ?? null,
      max_iterations: clampIterations(spec.max_iterations),
      budget_usd: clampBudget(spec.budget_usd),
      target_score: clampTarget(spec.target_score),
    })
    .select('id, name')
    .single()
  if (error || !data) throw new Error(`could not create the loop: ${error?.message ?? 'unknown error'}`)
  return { id: data.id as string, name: data.name as string }
}

// Resolve a loop by id or name, scoped to what this caller may run (their own
// loops + workspace-visible ones) — the access gate for the MCP/builtin surfaces,
// since the `loop` function itself only checks the loop exists and is active.
export async function resolveLoop(
  db: DB,
  owner: string,
  ref: string,
): Promise<{ id: string; name: string } | null> {
  const r = String(ref ?? '').trim()
  if (!r) return null
  const { data } = await db
    .from('loops')
    .select('id, name, owner_id, visibility')
    .or(`owner_id.eq.${owner},visibility.eq.workspace`)
  const found = (data ?? []).find(
    (l: { id: string; name: string }) => l.id === r || l.name.trim().toLowerCase() === r.toLowerCase(),
  )
  return found ? { id: found.id, name: found.name } : null
}

// Kick off a run by calling the `loop` edge function with the service-role key.
// That key carries no JWT `sub`, so the function falls back to the explicit
// `triggered_by` we pass to attribute the run to the acting user. The function
// returns 202 immediately (the run executes in a background task), so this is a
// quick fire-and-forget that hands back the run id to poll.
export async function triggerLoopRun(loopId: string, triggeredBy: string | null): Promise<{ run_id: string }> {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('server not configured to start loops')
  const res = await fetch(`${url}/functions/v1/loop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loop_id: loopId, triggered_by: triggeredBy }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`the loop did not start (HTTP ${res.status}): ${body.slice(0, 300)}`)
  try {
    const parsed = JSON.parse(body)
    if (!parsed.run_id) throw new Error('no run id was returned')
    return { run_id: parsed.run_id as string }
  } catch (err) {
    throw new Error(`unexpected response starting the loop: ${err instanceof Error ? err.message : 'parse error'}`)
  }
}

// deno-lint-ignore no-explicit-any
export async function getRun(db: DB, runId: string): Promise<any | null> {
  const r = String(runId ?? '').trim()
  if (!r) return null
  const { data } = await db.from('loop_runs').select('*').eq('id', r).maybeSingle()
  return data ?? null
}

// deno-lint-ignore no-explicit-any
export async function latestRunForLoop(db: DB, loopId: string): Promise<any | null> {
  const { data } = await db
    .from('loop_runs')
    .select('*')
    .eq('loop_id', loopId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

// A human-readable progress card for a run — the "check-in" payload. Includes the
// best output only once the run is finished so a poll mid-run stays compact.
// deno-lint-ignore no-explicit-any
export function formatRun(run: any): string {
  if (!run) return 'No run found.'
  const lines = [
    `Loop run ${run.id}`,
    `Status: ${run.status}${run.stop_reason ? ` (${run.stop_reason})` : ''}`,
    `Iterations so far: ${run.iterations ?? 0}`,
    `Cost so far: $${Number(run.cost_spent ?? 0).toFixed(4)}`,
    run.best_score == null ? 'Best score: n/a' : `Best score: ${run.best_score}/100`,
  ]
  if (run.status === 'running') lines.push('Still running — check again in a few seconds.')
  if (run.error) lines.push(`Error: ${run.error}`)
  if (run.status === 'done' && run.best_output) {
    lines.push('', 'Best output:', String(run.best_output).slice(0, 4000))
  }
  return lines.join('\n')
}

// List the loops this caller may run (their own + workspace-visible), newest first.
export async function listLoopsText(db: DB, owner: string): Promise<string> {
  const { data } = await db
    .from('loops')
    .select('id, name, goal, budget_usd, max_iterations, is_active, owner_id, visibility')
    .or(`owner_id.eq.${owner},visibility.eq.workspace`)
    .order('created_at', { ascending: false })
  if (!data || !data.length) return 'No loops yet.'
  return (data as Array<Record<string, unknown>>)
    .map(
      (l) =>
        `• ${l.name} (${l.id})${l.is_active ? '' : ' [inactive]'} — budget $${l.budget_usd}, ≤${l.max_iterations} iter — goal: ${String(l.goal ?? '').slice(0, 80)}`,
    )
    .join('\n')
}
