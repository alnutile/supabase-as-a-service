// Pure eval helpers — NO imports, so a permission-free unit test can pull these
// in without dragging the orchestrator/judge module graph (and its env reads +
// Supabase-client type noise) along. evals.ts re-exports them for the runtime.
export const DEFAULT_K = 6
export const MAX_K = 20
// A matrix run fans one suite across several models; cap it so a stray list can't
// spawn a huge number of background runs.
export const MAX_MODELS = 6

export type Assertion = Record<string, unknown>
export type AssertionResult = { type: string; pass: boolean; detail: string }

// deno-lint-ignore no-explicit-any
export type Case = { id: string; name: string; input: string; expected: string | null; assertions: any }

// Evaluate one assertion against text (+ optional retrieved doc names for rag).
export function evalAssertion(a: Assertion, docs: string[], text: string): AssertionResult {
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

// Normalize a models input into a clamped, de-duped list of slugs. Accepts an
// array, a comma/newline-separated string, or a single slug. An empty input →
// [null], i.e. one run at the profile default (the back-compat single-run path).
export function parseModels(input: unknown): (string | null)[] {
  let raw: string[] = []
  if (Array.isArray(input)) raw = input.map((m) => String(m ?? ''))
  else if (typeof input === 'string') raw = input.split(/[\n,]/)
  const cleaned = raw.map((s) => s.trim()).filter((s) => s !== '')
  const unique = Array.from(new Set(cleaned)).slice(0, MAX_MODELS)
  return unique.length ? unique : [null]
}

// A human-readable check-in for a single run (the poll payload).
// deno-lint-ignore no-explicit-any
export function formatEvalRun(run: any): string {
  if (!run) return 'No run found.'
  const pct = run.score == null ? 'n/a' : `${Math.round(run.score * 100)}%`
  const lines = [
    `Eval run ${run.id}`,
    `Status: ${run.status}${run.error ? ` — ${run.error}` : ''}`,
    `Model: ${run.model ?? 'profile default'}`,
    `Score: ${pct} (${run.passed}/${run.total} passed)`,
  ]
  if (run.cost != null) lines.push(`Cost: $${Number(run.cost).toFixed(4)}`)
  if (run.status === 'running') lines.push('Still running — check again in a few seconds.')
  return lines.join('\n')
}

// A side-by-side scorecard across models — the matrix-compare payload. Given the
// runs (one per model), sorts best-score-first so the winner reads at the top.
// deno-lint-ignore no-explicit-any
export function formatMatrix(runs: any[]): string {
  if (!runs.length) return 'No runs yet.'
  const rows = runs
    .map((r) => ({
      model: r.model ?? 'profile default',
      status: r.status,
      pct: r.score == null ? null : Math.round(r.score * 100),
      passed: r.passed,
      total: r.total,
      cost: r.cost,
    }))
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
  const anyRunning = rows.some((r) => r.status === 'running')
  const lines = rows.map((r) => {
    const score = r.status === 'running' ? 'running…' : r.pct == null ? '—' : `${r.pct}% (${r.passed}/${r.total})`
    const cost = r.cost != null ? ` · $${Number(r.cost).toFixed(4)}` : ''
    return `• ${r.model}: ${score}${cost}`
  })
  if (anyRunning) lines.push('', 'Some runs are still going — poll again for the full comparison.')
  return lines.join('\n')
}
