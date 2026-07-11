// Supabase Edge Function: `evals` (verify_jwt=true — the service-role key also
// passes the gateway, which is how MCP triggers background runs).
// Runs an eval suite and scores it. The per-case work lives in `_shared/evals.ts`
// (executeSuiteRun) so the UI path here and the MCP path (triggerEvalRun) share
// one implementation.
//   • target `rag`  — embeds each case input (gte-small), retrieves top-K chunks
//     via match_document_chunks, checks assertions deterministically. No model.
//   • target `chat`/`agent` — answers each question through the REAL orchestrator
//     (optionally grounded in the suite's collections), then a JUDGE model grades
//     the answer against the case's reference + rubric. Verdict is enforced in
//     code, never fed back to the orchestrator.
//
// Two run shapes:
//   • single/sync (the in-app admin UI) — runs to completion, returns the summary.
//   • matrix/background (`models: [...]`, `background: true`, service role) —
//     pre-creates one run per model, returns their ids immediately, executes in a
//     background task. The model-compare + MCP flow.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { createRun, executeSuiteRun, parseModels } from '../_shared/evals.ts'

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) return json({ error: 'Server misconfigured' }, 500)

  let body: { suite_id?: string; model?: string; models?: unknown; background?: boolean; triggered_by?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  // A real user JWT carries `sub`, so it wins. Internal callers (the MCP server /
  // triggerEvalRun) reach this with the service-role key — no `sub` — and pass an
  // explicit `triggered_by`. A user can never spoof another because their own
  // `sub` always takes precedence over the body field.
  const jwtUser = userIdFromAuth(req)
  const bodyTriggeredBy = typeof body.triggered_by === 'string' ? body.triggered_by : null
  const userId = jwtUser ?? bodyTriggeredBy
  if (!userId) return json({ error: 'Unauthorized' }, 401)

  const db = createClient(supabaseUrl, serviceKey)
  // Evals are admin-only. Re-enforce on the RESOLVED user (the JWT's sub, or the
  // attributed user for an internal call) — never trust the body alone.
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  if (!profile?.is_admin) return json({ error: 'Admin only' }, 403)

  const suiteId = String(body.suite_id ?? '')
  if (!suiteId) return json({ error: 'suite_id is required' }, 400)

  const { data: suite } = await db.from('eval_suites').select('id').eq('id', suiteId).maybeSingle()
  if (!suite) return json({ error: 'Suite not found' }, 404)

  const { data: cases } = await db.from('eval_cases').select('id').eq('suite_id', suiteId)
  if (!cases || cases.length === 0) return json({ error: 'This suite has no cases yet.' }, 400)

  const models = parseModels(body.models ?? body.model)
  const background = body.background === true

  // Background / matrix: pre-create every run, return the ids now, execute later.
  if (background) {
    const runIds: string[] = []
    for (const m of models) runIds.push(await createRun(db, suiteId, m, userId, cases.length))
    // deno-lint-ignore no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime
    const work = (async () => {
      for (const id of runIds) {
        try { await executeSuiteRun(db, id) } catch { /* errors land on the run row */ }
      }
    })()
    if (runtime?.waitUntil) runtime.waitUntil(work)
    else await work
    return json({ run_ids: runIds })
  }

  // Sync (UI): run each model in turn to completion and return the first summary
  // (the UI sends a single model or none, so this is one run in practice).
  try {
    const summaries = []
    for (const m of models) {
      const runId = await createRun(db, suiteId, m, userId, cases.length)
      summaries.push(await executeSuiteRun(db, runId))
    }
    const first = summaries[0]
    if (first.error) return json({ error: first.error, run_id: first.runId }, 500)
    return json({
      run_id: first.runId,
      run_ids: summaries.map((s) => s.runId),
      total: first.total,
      passed: first.passed,
      score: first.score,
      cost: first.cost,
    })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'run failed' }, 500)
  }
})
