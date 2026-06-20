// Supabase Edge Function: `evals` (verify_jwt=true, admin-only).
// Runs an eval suite and scores it. Phase 1 implements the `rag` target: for each
// case it embeds the input with the free in-edge gte-small model (the same model
// search_documents uses), retrieves the top-K chunks via match_document_chunks,
// and checks the case's assertions against what came back — deterministically, no
// LLM judge. It writes one eval_results row per case and a headline score on the
// eval_run. Agent/chat targets (which need the orchestrator + a rubric judge)
// land in Phase 2; this function rejects them with a clear message for now.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

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

// Evaluate one assertion against the retrieved passages. `docs` are the retrieved
// document names (lowercased, in similarity order); `text` is their concatenated
// content (lowercased).
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
      return { type, pass: hit, detail: hit ? `passages contain "${a.text}"` : `missing "${a.text}"` }
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
    .select('id, name, target_kind')
    .eq('id', suiteId)
    .maybeSingle()
  if (!suite) return json({ error: 'Suite not found' }, 404)

  if (suite.target_kind !== 'rag') {
    return json(
      {
        error:
          `Running "${suite.target_kind}" suites isn't supported yet — only retrieval (rag) suites run today. ` +
          `Agent/chat task scoring (with a rubric judge) is the next phase.`,
      },
      400,
    )
  }

  const { data: cases } = await db
    .from('eval_cases')
    .select('id, name, input, assertions')
    .eq('suite_id', suiteId)
    .order('created_at', { ascending: true })
  if (!cases || cases.length === 0) return json({ error: 'This suite has no cases yet.' }, 400)

  // Open a run row up front so the UI can see it even if something fails midway.
  const { data: run, error: runErr } = await db
    .from('eval_runs')
    .insert({ suite_id: suiteId, model: modelOverride, status: 'running', total: cases.length, triggered_by: userId })
    .select('id')
    .single()
  if (runErr || !run) return json({ error: `Could not start the run: ${runErr?.message ?? 'unknown'}` }, 500)
  const runId = run.id as string

  // Largest k requested across all assertions decides how many chunks to fetch.
  let k = DEFAULT_K
  for (const c of cases) {
    for (const a of (Array.isArray(c.assertions) ? c.assertions : []) as Assertion[]) {
      if (String(a.type).toLowerCase() === 'recall_at_k') k = Math.max(k, Number(a.k ?? DEFAULT_K))
    }
  }
  k = Math.min(Math.max(1, k), MAX_K)

  // deno-lint-ignore no-explicit-any
  const model = new (globalThis as any).Supabase.ai.Session('gte-small')
  let passedCount = 0

  try {
    for (const c of cases) {
      const started = Date.now()
      const assertions = (Array.isArray(c.assertions) ? c.assertions : []) as Assertion[]
      let passed = false
      let score: number | null = null
      let output = ''
      let detail: AssertionResult[] = []

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
          detail = [{ type: 'none', pass: false, detail: 'case has no assertions' }]
          passed = false
          score = 0
        } else {
          detail = assertions.map((a) => evalAssertion(a, docs, text))
          const ok = detail.filter((d) => d.pass).length
          score = ok / assertions.length
          passed = ok === assertions.length
        }
      } catch (err) {
        detail = [{ type: 'error', pass: false, detail: err instanceof Error ? err.message : 'retrieval failed' }]
        passed = false
        score = 0
      }

      if (passed) passedCount++
      await db.from('eval_results').insert({
        run_id: runId,
        case_id: c.id,
        case_name: c.name || String(c.input ?? '').slice(0, 60),
        passed,
        score,
        output,
        detail,
        latency_ms: Date.now() - started,
      })
    }

    const finalScore = cases.length ? passedCount / cases.length : 0
    await db.from('eval_runs').update({
      status: 'done',
      passed: passedCount,
      total: cases.length,
      score: finalScore,
      finished_at: new Date().toISOString(),
    }).eq('id', runId)

    await db.from('activity_log').insert({
      type: 'eval.run',
      summary: `Ran eval "${suite.name}": ${passedCount}/${cases.length} passed (${Math.round(finalScore * 100)}%)`,
      detail: { suite_id: suiteId, run_id: runId, score: finalScore },
      actor_id: userId,
    })

    return json({ run_id: runId, total: cases.length, passed: passedCount, score: finalScore })
  } catch (err) {
    await db.from('eval_runs').update({
      status: 'error',
      error: err instanceof Error ? err.message : 'run failed',
      finished_at: new Date().toISOString(),
    }).eq('id', runId)
    return json({ error: err instanceof Error ? err.message : 'run failed', run_id: runId }, 500)
  }
})
