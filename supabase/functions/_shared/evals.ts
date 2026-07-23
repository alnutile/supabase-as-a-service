// Shared helpers for the evals system — the Promptfoo-style suites driven by the
// `evals` edge function (run each case through the real pipeline, score it). Like
// `_shared/loops.ts`, these let BOTH entry points spin an eval up through one code
// path so they never drift:
//   • the in-app UI (a signed-in admin) — POSTs to the `evals` function directly
//   • the MCP server (an external Claude) — triggerEvalRun POSTs with the service
//     role, and the run(s) execute in the background so a long chat/agent suite
//     doesn't block; the caller polls with get_eval_run.
//
// The pure bits live in evals_pure.ts (no imports) so tests/evals_test.ts can pull
// them without dragging this file's orchestrator/judge graph. executeSuiteRun does
// the DB work and lazily imports the orchestrator/judge (which read env at module
// load) so even importing THIS file stays cheap.
import {
  type Assertion,
  type AssertionResult,
  type Case,
  DEFAULT_K,
  evalAssertion,
  MAX_K,
  summarizeTrace,
  type ToolCall,
} from './evals_pure.ts'

// Re-export the pure helpers so existing call sites can keep importing from here.
export {
  DEFAULT_K,
  evalAssertion,
  formatEvalRun,
  formatMatrix,
  formatRunDetail,
  isReadOnlyBuiltin,
  MAX_K,
  MAX_MODELS,
  parseModels,
  summarizeTrace,
} from './evals_pure.ts'
export type { Assertion, AssertionResult, AssertionContext, Case, ToolCall } from './evals_pure.ts'
import { type ChunkHit, hybridChunkSearch } from './retrieval.ts'

// deno-lint-ignore no-explicit-any
type DB = any

// Resolve a suite by id or exact (case-insensitive) name.
// deno-lint-ignore no-explicit-any
export async function resolveSuite(db: DB, ref: string): Promise<any | null> {
  const r = String(ref ?? '').trim()
  if (!r) return null
  const { data } = await db.from('eval_suites').select('*')
  const found = (data ?? []).find(
    (s: { id: string; name: string }) => s.id === r || s.name.trim().toLowerCase() === r.toLowerCase(),
  )
  return found ?? null
}

// A one-line-per-suite listing (id, target, latest score) for the MCP list tool.
export async function listSuitesText(db: DB): Promise<string> {
  const { data: suites } = await db
    .from('eval_suites')
    .select('id, name, target_kind, description')
    .order('updated_at', { ascending: false })
  if (!suites || !suites.length) return 'No eval suites yet.'
  // Latest run per suite for the score badge (reduce recent runs client-side).
  const { data: runs } = await db
    .from('eval_runs')
    .select('suite_id, score, passed, total, model, created_at')
    .order('created_at', { ascending: false })
    .limit(300)
  const latest: Record<string, { score: number | null; passed: number; total: number }> = {}
  for (const rn of runs ?? []) if (!latest[rn.suite_id]) latest[rn.suite_id] = rn
  return (suites as Array<{ id: string; name: string; target_kind: string; description: string }>)
    .map((s) => {
      const l = latest[s.id]
      const badge = l ? `${l.score == null ? '—' : Math.round(l.score * 100) + '%'} (${l.passed}/${l.total})` : 'not run'
      return `• ${s.name} (${s.id}) — target ${s.target_kind}, latest ${badge}${s.description ? ` — ${s.description}` : ''}`
    })
    .join('\n')
}

// Insert a fresh run row (status running) and return its id. `total` is set now so
// a poll mid-run shows the denominator; executeSuiteRun re-confirms it at the end.
export async function createRun(
  db: DB,
  suiteId: string,
  model: string | null,
  triggeredBy: string | null,
  total: number,
): Promise<string> {
  const { data, error } = await db
    .from('eval_runs')
    .insert({ suite_id: suiteId, model, status: 'running', total, triggered_by: triggeredBy })
    .select('id')
    .single()
  if (error || !data) throw new Error(`could not start the run: ${error?.message ?? 'unknown'}`)
  return data.id as string
}

// Execute an already-created run to completion: load its suite + cases, run every
// case (rag deterministically, or chat/agent through the orchestrator + judge),
// write a result row per case, then finalize the run's headline score + cost and
// log activity. Self-contained (loads everything off the run) so the sync UI path
// and the background MCP path share it. Never throws — errors land on the run row.
export async function executeSuiteRun(
  db: DB,
  runId: string,
): Promise<{ runId: string; total: number; passed: number; score: number; cost: number; error?: string }> {
  const { data: run } = await db.from('eval_runs').select('id, suite_id, model, triggered_by').eq('id', runId).maybeSingle()
  if (!run) return { runId, total: 0, passed: 0, score: 0, cost: 0, error: 'run not found' }
  const modelOverride: string | null = run.model ?? null
  const userId: string | null = run.triggered_by ?? null

  const { data: suite } = await db
    .from('eval_suites')
    .select('id, name, target_kind, agent_id, rubric, judge_model, collection_ids, sandbox_tools')
    .eq('id', run.suite_id)
    .maybeSingle()
  const { data: cases } = await db
    .from('eval_cases')
    .select('id, name, input, expected, assertions')
    .eq('suite_id', run.suite_id)
    .order('created_at', { ascending: true })

  const fail = async (msg: string) => {
    await db.from('eval_runs').update({ status: 'error', error: msg, finished_at: new Date().toISOString() }).eq('id', runId)
    return { runId, total: 0, passed: 0, score: 0, cost: 0, error: msg }
  }
  if (!suite) return await fail('suite not found')
  if (!cases || cases.length === 0) return await fail('this suite has no cases')

  const collectionIds: string[] = Array.isArray(suite.collection_ids) ? suite.collection_ids : []

  // Lazy so this module stays import-side-effect-free for the unit tests.
  const { runOrchestrator } = await import('./orchestrator.ts')
  const { runJudge } = await import('./judge.ts')
  const sandboxTools = suite.sandbox_tools !== false

  // An agent suite runs each question through that agent's prompt + tools.
  let agentSystem: string | null = null
  let agentToolIds: string[] | null = null
  if (suite.target_kind === 'agent') {
    if (!suite.agent_id) return await fail('this agent suite has no agent selected')
    const { data: agent } = await db.from('agents').select('instructions, tool_ids').eq('id', suite.agent_id).maybeSingle()
    if (!agent) return await fail("the suite's agent no longer exists")
    agentSystem = agent.instructions ?? null
    agentToolIds = Array.isArray(agent.tool_ids) ? agent.tool_ids : null
  }

  let passedCount = 0
  let totalCost = 0
  // For the `rag` target we score on HYBRID retrieval (mirrors production
  // search_documents) but also run vector-only on the same cases as a baseline, so
  // one run is a vector-vs-hybrid A/B. This holds the vector baseline's pass count
  // for the run summary; stays null for non-rag targets.
  let ragVectorPassed: number | null = null

  try {
    if (suite.target_kind === 'rag') {
      let k = DEFAULT_K
      for (const c of cases as Case[]) {
        for (const a of (Array.isArray(c.assertions) ? c.assertions : []) as Assertion[]) {
          if (String(a.type).toLowerCase() === 'recall_at_k') k = Math.max(k, Number(a.k ?? DEFAULT_K))
        }
      }
      k = Math.min(Math.max(1, k), MAX_K)
      // deno-lint-ignore no-explicit-any
      const model = new (globalThis as any).Supabase.ai.Session('gte-small')
      ragVectorPassed = 0

      // Grade one retrieved chunk set against a case's assertions.
      const gradeRows = (
        list: Assertion[],
        rows: ChunkHit[],
      ): { assertions: AssertionResult[]; score: number; passed: boolean } => {
        const docs = rows.map((r) => String(r.document_name ?? '').toLowerCase())
        const text = rows.map((r) => String(r.content ?? '')).join('\n\n').toLowerCase()
        const ar: AssertionResult[] = list.length === 0
          ? [{ type: 'none', pass: false, detail: 'case has no assertions' }]
          : list.map((a) => evalAssertion(a, { docs, text }))
        const ok = ar.filter((d) => d.pass).length
        return { assertions: ar, score: ar.length ? ok / ar.length : 0, passed: ar.length > 0 && ok === ar.length }
      }

      for (const c of cases as Case[]) {
        const started = Date.now()
        const assertions = (Array.isArray(c.assertions) ? c.assertions : []) as Assertion[]
        let passed = false
        let score: number | null = null
        let output = ''
        let aResults: AssertionResult[] = []
        // deno-lint-ignore no-explicit-any
        let retrievalDetail: Record<string, any> | null = null
        try {
          const embedding = await model.run(String(c.input ?? ''), { mean_pool: true, normalize: true })
          // ONE retrieval call returns both the fused (hybrid) hits and the
          // vector-only top-k baseline — so the A/B costs a single round trip
          // (the previous separate match_document_chunks call is gone; that
          // per-case chattiness was tipping the edge worker over its budget on
          // larger suites).
          const { hits: hRows, vector: vRows } = await hybridChunkSearch(db, {
            embedding, queryText: String(c.input ?? ''), ownerId: userId, top: k, pool: Math.max(k * 4, 24),
          })
          const vector = gradeRows(assertions, vRows)
          const hybrid = gradeRows(assertions, hRows)
          // Headline scores on hybrid; vector is recorded as the baseline.
          aResults = hybrid.assertions
          score = hybrid.score
          passed = hybrid.passed
          output = hRows
            .map((r, i) => `[${i + 1}] (${r.document_name ?? 'document'}) ${String(r.content ?? '').slice(0, 200)}`)
            .join('\n')
          retrievalDetail = {
            hybrid: { passed: hybrid.passed, score: hybrid.score },
            vector: { passed: vector.passed, score: vector.score, assertions: vector.assertions },
          }
          if (vector.passed) ragVectorPassed++
        } catch (err) {
          aResults = [{ type: 'error', pass: false, detail: err instanceof Error ? err.message : 'retrieval failed' }]
          score = 0
        }
        if (passed) passedCount++
        await db.from('eval_results').insert({
          run_id: runId, case_id: c.id, case_name: c.name || String(c.input ?? '').slice(0, 60),
          passed, score, output,
          detail: retrievalDetail ? { assertions: aResults, retrieval: retrievalDetail } : { assertions: aResults },
          latency_ms: Date.now() - started,
        })
      }
    } else if (suite.target_kind === 'chat' || suite.target_kind === 'agent') {
      for (const c of cases as Case[]) {
        const started = Date.now()
        const assertions = (Array.isArray(c.assertions) ? c.assertions : []) as Assertion[]
        let output = ''
        let aResults: AssertionResult[] = []
        // deno-lint-ignore no-explicit-any
        let judge: any = null
        let trace: ToolCall[] = []
        let passed = false
        let score: number | null = null
        try {
          const ans = await runOrchestrator(db, {
            question: String(c.input ?? ''),
            system: agentSystem,
            toolIds: agentToolIds,
            model: modelOverride,
            userId,
            collectionIds,
            captureTrace: true,
            sandboxTools,
          })
          output = ans.text
          trace = ans.trace ?? []
          totalCost += ans.cost

          aResults = assertions.map((a) => evalAssertion(a, { text: output.toLowerCase(), trace }))
          const assertionsPass = aResults.every((d) => d.pass)

          // Only grade with the judge when there's something to grade against — a
          // reference answer or a suite rubric. A pure tool-usage case (assertions
          // only, no reference) passes on its assertions alone.
          const wantJudge = Boolean((c.expected && c.expected.trim()) || (suite.rubric && suite.rubric.trim()))
          if (wantJudge) {
            const verdict = await runJudge(db, {
              question: String(c.input ?? ''),
              reference: c.expected,
              output,
              rubric: suite.rubric,
              model: suite.judge_model,
            })
            totalCost += verdict.cost
            judge = { pass: verdict.pass, score: verdict.score, reason: verdict.reason }
            passed = verdict.pass && assertionsPass
            score = verdict.score
          } else {
            judge = { pass: true, score: 1, reason: 'no reference/rubric — graded on tool assertions only' }
            passed = assertionsPass && aResults.length > 0
            score = aResults.length ? aResults.filter((d) => d.pass).length / aResults.length : 0
          }
        } catch (err) {
          judge = { pass: false, score: 0, reason: err instanceof Error ? err.message : 'run failed' }
          score = 0
        }
        if (passed) passedCount++
        await db.from('eval_results').insert({
          run_id: runId, case_id: c.id, case_name: c.name || String(c.input ?? '').slice(0, 60),
          passed, score, output, latency_ms: Date.now() - started,
          detail: { assertions: aResults, judge, tools: trace },
        })
      }
    } else if (suite.target_kind === 'tool') {
      // Deterministic: no model. Each case input is JSON {"tool","input"}; dispatch
      // the tool directly (same as run-tool) and grade the result text with the
      // ordinary text assertions. Tests whether a tool itself is correct.
      const { runBuiltin } = await import('./builtins.ts')
      const { runHttpTool } = await import('./http_tool.ts')
      const { data: toolRows } = await db.from('tools').select('*').eq('is_active', true)
      // deno-lint-ignore no-explicit-any
      const toolByName = new Map((toolRows ?? []).map((t: any) => [t.name, t]))

      for (const c of cases as Case[]) {
        const started = Date.now()
        const assertions = (Array.isArray(c.assertions) ? c.assertions : []) as Assertion[]
        let passed = false
        let score: number | null = null
        let output = ''
        let aResults: AssertionResult[] = []
        let call: ToolCall | null = null
        try {
          let spec: { tool?: string; input?: unknown }
          try { spec = JSON.parse(String(c.input ?? '{}')) } catch { spec = {} }
          const toolName = String(spec.tool ?? '').trim()
          const toolInput = (spec.input ?? {}) as Record<string, unknown>
          if (!toolName) throw new Error('case input must be JSON like {"tool":"name","input":{...}}')
          // deno-lint-ignore no-explicit-any
          const row = toolByName.get(toolName) as any
          if (!row) throw new Error(`no active tool named "${toolName}"`)
          if (row.kind === 'builtin') output = await runBuiltin(db, toolName, toolInput, userId)
          else if (row.kind === 'http') output = await runHttpTool(db, row, toolInput)
          else throw new Error(`tool "${toolName}" (kind ${row.kind}) can't be run directly`)
          call = { name: toolName, arguments: toolInput, result: String(output).slice(0, 500) }
          const text = String(output).toLowerCase()
          if (assertions.length === 0) {
            aResults = [{ type: 'none', pass: false, detail: 'case has no assertions' }]
          } else {
            aResults = assertions.map((a) => evalAssertion(a, { text, trace: [call as ToolCall] }))
          }
          const ok = aResults.filter((d) => d.pass).length
          score = aResults.length ? ok / aResults.length : 0
          passed = aResults.length > 0 && ok === aResults.length
        } catch (err) {
          aResults = [{ type: 'error', pass: false, detail: err instanceof Error ? err.message : 'tool run failed' }]
          score = 0
        }
        if (passed) passedCount++
        await db.from('eval_results').insert({
          run_id: runId, case_id: c.id, case_name: c.name || String(c.input ?? '').slice(0, 60),
          passed, score, output, latency_ms: Date.now() - started,
          detail: { assertions: aResults, tools: call ? [call] : [] },
        })
      }
    } else {
      return await fail(`unknown target ${suite.target_kind}`)
    }

    const finalScore = cases.length ? passedCount / cases.length : 0
    await db.from('eval_runs').update({
      status: 'done', passed: passedCount, total: cases.length, score: finalScore,
      cost: totalCost || null, finished_at: new Date().toISOString(),
    }).eq('id', runId)

    // For rag runs the headline is hybrid; append the vector baseline so the A/B
    // reads at a glance ("hybrid 8/10 vs vector 5/10").
    const abSuffix = ragVectorPassed !== null
      ? ` — hybrid ${passedCount}/${cases.length} vs vector ${ragVectorPassed}/${cases.length}`
      : ''
    await db.from('activity_log').insert({
      type: 'eval.run',
      summary: `Ran eval "${suite.name}": ${passedCount}/${cases.length} passed (${Math.round(finalScore * 100)}%)${modelOverride ? ` [${modelOverride}]` : ''}${abSuffix}`,
      detail: {
        suite_id: suite.id, run_id: runId, score: finalScore, model: modelOverride, cost: totalCost,
        ...(ragVectorPassed !== null ? { retrieval_ab: { hybrid_passed: passedCount, vector_passed: ragVectorPassed, total: cases.length } } : {}),
      },
      actor_id: userId,
    })

    return { runId, total: cases.length, passed: passedCount, score: finalScore, cost: totalCost }
  } catch (err) {
    return await fail(err instanceof Error ? err.message : 'run failed')
  }
}

// Kick off one or more background runs of a suite by calling the `evals` function
// with the service-role key. That key passes the gateway but carries no user
// `sub`, so the function attributes the run to the explicit `triggered_by` (a
// caller can't spoof another user — a real JWT's `sub` always wins). The function
// pre-creates the run rows and returns their ids immediately (the work runs in a
// background task), so this is a quick fire-and-forget for the poll-later flow.
export async function triggerEvalRun(
  suiteId: string,
  models: (string | null)[],
  triggeredBy: string | null,
): Promise<{ run_ids: string[] }> {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('server not configured to run evals')
  const res = await fetch(`${url}/functions/v1/evals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ suite_id: suiteId, models, background: true, triggered_by: triggeredBy }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`the eval did not start (HTTP ${res.status}): ${body.slice(0, 300)}`)
  try {
    const parsed = JSON.parse(body)
    const ids = Array.isArray(parsed.run_ids) ? parsed.run_ids : parsed.run_id ? [parsed.run_id] : []
    if (!ids.length) throw new Error('no run ids were returned')
    return { run_ids: ids as string[] }
  } catch (err) {
    throw new Error(`unexpected response starting the eval: ${err instanceof Error ? err.message : 'parse error'}`)
  }
}

// deno-lint-ignore no-explicit-any
export async function getEvalRun(db: DB, runId: string): Promise<any | null> {
  const r = String(runId ?? '').trim()
  if (!r) return null
  const { data } = await db.from('eval_runs').select('*').eq('id', r).maybeSingle()
  return data ?? null
}

// The per-case rows for one run (for the MCP detail view — tools called + failures).
// deno-lint-ignore no-explicit-any
export async function getResultsForRun(db: DB, runId: string): Promise<any[]> {
  const { data } = await db.from('eval_results').select('*').eq('run_id', runId).order('created_at', { ascending: true })
  return data ?? []
}

// deno-lint-ignore no-explicit-any
export async function latestRunsForSuite(db: DB, suiteId: string, limit = 6): Promise<any[]> {
  const { data } = await db
    .from('eval_runs')
    .select('*')
    .eq('suite_id', suiteId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return data ?? []
}
