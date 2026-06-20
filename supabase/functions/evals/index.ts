// Supabase Edge Function: `evals` (verify_jwt=true, admin-only).
// Runs an eval suite and scores it.
//   • target `rag`  — embeds each case input (gte-small), retrieves top-K chunks
//     via match_document_chunks, checks assertions deterministically. No model.
//   • target `chat`/`agent` — answers each question through the REAL orchestrator
//     (always-on prompts + tools + search_documents; an `agent` suite uses the
//     agent's prompt + tools), then a JUDGE model grades the answer against the
//     case's reference answer + the suite rubric. Deterministic assertions can
//     also run on the answer text. Judge verdict + assertions are enforced in
//     code, never fed back to the orchestrator.
// Writes one eval_results row per case and a headline pass-rate + cost on the run.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { runOrchestrator } from '../_shared/orchestrator.ts'
import { runJudge } from '../_shared/judge.ts'

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

const DEFAULT_K = 6
const MAX_K = 20

type Assertion = Record<string, unknown>
type AssertionResult = { type: string; pass: boolean; detail: string }

// Evaluate one assertion against text (+ optional retrieved doc names for rag).
function evalAssertion(a: Assertion, docs: string[], text: string): AssertionResult {
  const type = String(a.type ?? '').toLowerCase()
  switch (type) {
    case 'retrieves':
    case 'recall_at_k': {
      const needle = String(a.doc ?? '').toLowerCase().trim()
      const k = type === 'recall_at_k' ? Math.min(Math.max(1, Number(a.k ?? DEFAULT_K)), MAX_K) : docs.length
      const hit = needle !== '' && docs.slice(0, k).some((d) => d.includes(needle))
      return { type, pass: hit, detail: hit ? `found "${a.doc}" in top ${k}` : `"${a.doc}" not in top ${k}` }
    }
    case 'contains': {
      const needle = String(a.text ?? '').toLowerCase()
      const hit = needle !== '' && text.includes(needle)
      return { type, pass: hit, detail: hit ? `contains "${a.text}"` : `missing "${a.text}"` }
    }
    case 'not_contains': {
      const needle = String(a.text ?? '').toLowerCase()
      const hit = needle !== '' && text.includes(needle)
      return { type, pass: !hit, detail: hit ? `unexpectedly found "${a.text}"` : `absent as expected` }
    }
    case 'regex': {
      try {
        const re = new RegExp(String(a.pattern ?? ''), 'i')
        const hit = re.test(text)
        return { type, pass: hit, detail: hit ? `matched /${a.pattern}/` : `no match for /${a.pattern}/` }
      } catch {
        return { type, pass: false, detail: `invalid regex /${a.pattern}/` }
      }
    }
    default:
      return { type: type || 'unknown', pass: false, detail: `unsupported assertion type "${a.type}"` }
  }
}

// deno-lint-ignore no-explicit-any
type Case = { id: string; name: string; input: string; expected: string | null; assertions: any }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const userId = userIdFromAuth(req)
  if (!supabaseUrl || !serviceKey || !userId) return json({ error: 'Unauthorized' }, 401)

  const db = createClient(supabaseUrl, serviceKey)
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  if (!profile?.is_admin) return json({ error: 'Admin only' }, 403)

  let body: { suite_id?: string; model?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const suiteId = String(body.suite_id ?? '')
  if (!suiteId) return json({ error: 'suite_id is required' }, 400)
  const modelOverride = body.model ? String(body.model) : null

  const { data: suite } = await db
    .from('eval_suites')
    .select('id, name, target_kind, agent_id, rubric, judge_model')
    .eq('id', suiteId)
    .maybeSingle()
  if (!suite) return json({ error: 'Suite not found' }, 404)

  const { data: cases } = await db
    .from('eval_cases')
    .select('id, name, input, expected, assertions')
    .eq('suite_id', suiteId)
    .order('created_at', { ascending: true })
  if (!cases || cases.length === 0) return json({ error: 'This suite has no cases yet.' }, 400)

  // An agent suite runs each question through that agent's prompt + tools.
  let agentSystem: string | null = null
  let agentToolIds: string[] | null = null
  if (suite.target_kind === 'agent') {
    if (!suite.agent_id) return json({ error: 'This agent suite has no agent selected.' }, 400)
    const { data: agent } = await db.from('agents').select('instructions, tool_ids').eq('id', suite.agent_id).maybeSingle()
    if (!agent) return json({ error: 'The suite\'s agent no longer exists.' }, 400)
    agentSystem = agent.instructions ?? null
    agentToolIds = Array.isArray(agent.tool_ids) ? agent.tool_ids : null
  }

  const { data: run, error: runErr } = await db
    .from('eval_runs')
    .insert({ suite_id: suiteId, model: modelOverride, status: 'running', total: cases.length, triggered_by: userId })
    .select('id')
    .single()
  if (runErr || !run) return json({ error: `Could not start the run: ${runErr?.message ?? 'unknown'}` }, 500)
  const runId = run.id as string

  let passedCount = 0
  let totalCost = 0

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

      for (const c of cases as Case[]) {
        const started = Date.now()
        const assertions = (Array.isArray(c.assertions) ? c.assertions : []) as Assertion[]
        let passed = false
        let score: number | null = null
        let output = ''
        let aResults: AssertionResult[] = []
        try {
          const embedding = await model.run(String(c.input ?? ''), { mean_pool: true, normalize: true })
          const { data: matches } = await db.rpc('match_document_chunks', {
            query_embedding: embedding,
            match_owner: userId,
            match_count: k,
          })
          const rows = (matches ?? []) as Array<{ content: string; document_name?: string }>
          const docs = rows.map((r) => String(r.document_name ?? '').toLowerCase())
          const text = rows.map((r) => String(r.content ?? '')).join('\n\n').toLowerCase()
          output = rows
            .map((r, i) => `[${i + 1}] (${r.document_name ?? 'document'}) ${String(r.content ?? '').slice(0, 200)}`)
            .join('\n')
          if (assertions.length === 0) {
            aResults = [{ type: 'none', pass: false, detail: 'case has no assertions' }]
          } else {
            aResults = assertions.map((a) => evalAssertion(a, docs, text))
          }
          const ok = aResults.filter((d) => d.pass).length
          score = aResults.length ? ok / aResults.length : 0
          passed = aResults.length > 0 && ok === aResults.length
        } catch (err) {
          aResults = [{ type: 'error', pass: false, detail: err instanceof Error ? err.message : 'retrieval failed' }]
          score = 0
        }
        if (passed) passedCount++
        await db.from('eval_results').insert({
          run_id: runId, case_id: c.id, case_name: c.name || String(c.input ?? '').slice(0, 60),
          passed, score, output, detail: { assertions: aResults }, latency_ms: Date.now() - started,
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
        let passed = false
        let score: number | null = null
        try {
          const ans = await runOrchestrator(db, {
            question: String(c.input ?? ''),
            system: agentSystem,
            toolIds: agentToolIds,
            model: modelOverride,
            userId,
          })
          output = ans.text
          totalCost += ans.cost

          const verdict = await runJudge(db, {
            question: String(c.input ?? ''),
            reference: c.expected,
            output,
            rubric: suite.rubric,
            model: suite.judge_model,
          })
          totalCost += verdict.cost
          judge = { pass: verdict.pass, score: verdict.score, reason: verdict.reason }

          aResults = assertions.map((a) => evalAssertion(a, [], output.toLowerCase()))
          const assertionsPass = aResults.every((d) => d.pass)
          passed = verdict.pass && assertionsPass
          score = verdict.score
        } catch (err) {
          judge = { pass: false, score: 0, reason: err instanceof Error ? err.message : 'run failed' }
          score = 0
        }
        if (passed) passedCount++
        await db.from('eval_results').insert({
          run_id: runId, case_id: c.id, case_name: c.name || String(c.input ?? '').slice(0, 60),
          passed, score, output, detail: { assertions: aResults, judge }, latency_ms: Date.now() - started,
        })
      }
    } else {
      await db.from('eval_runs').update({ status: 'error', error: `unknown target ${suite.target_kind}`, finished_at: new Date().toISOString() }).eq('id', runId)
      return json({ error: `Unknown target kind: ${suite.target_kind}` }, 400)
    }

    const finalScore = cases.length ? passedCount / cases.length : 0
    await db.from('eval_runs').update({
      status: 'done', passed: passedCount, total: cases.length, score: finalScore,
      cost: totalCost || null, finished_at: new Date().toISOString(),
    }).eq('id', runId)

    await db.from('activity_log').insert({
      type: 'eval.run',
      summary: `Ran eval "${suite.name}": ${passedCount}/${cases.length} passed (${Math.round(finalScore * 100)}%)`,
      detail: { suite_id: suiteId, run_id: runId, score: finalScore, model: modelOverride, cost: totalCost },
      actor_id: userId,
    })

    return json({ run_id: runId, total: cases.length, passed: passedCount, score: finalScore, cost: totalCost })
  } catch (err) {
    await db.from('eval_runs').update({
      status: 'error', error: err instanceof Error ? err.message : 'run failed', finished_at: new Date().toISOString(),
    }).eq('id', runId)
    return json({ error: err instanceof Error ? err.message : 'run failed', run_id: runId }, 500)
  }
})
