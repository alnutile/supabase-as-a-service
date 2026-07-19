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

// One tool invocation captured during a chat/agent run — what the assistant
// actually called, with what arguments, and whether the eval sandbox stubbed it.
export type ToolCall = { name: string; arguments: Record<string, unknown>; result?: string; sandboxed?: boolean }

// What an assertion is evaluated against: retrieved doc names (rag), the answer /
// result text, and the tool-call trace (tool-usage assertions).
export type AssertionContext = { docs?: string[]; text?: string; trace?: ToolCall[] }

// deno-lint-ignore no-explicit-any
export type Case = { id: string; name: string; input: string; expected: string | null; assertions: any }

// Which builtins are safe to actually EXECUTE inside a sandboxed eval run:
// pure reads with no data mutation, no external calls, no credential exposure.
// Classify by prefix so new read-only builtins are covered automatically; the one
// exception is get_secret (a read, but it returns a raw credential — never run it
// in an eval). Everything else — writes, http/web/mcp tools — is captured but not
// executed. Used by runOrchestrator when opts.sandboxTools is set.
export function isReadOnlyBuiltin(name: string): boolean {
  if (name === 'get_secret') return false
  return /^(list_|get_|query_|search_)/.test(name) || name === 'check_email'
}

// Evaluate one assertion against the context (retrieved docs, answer/result text,
// and/or the tool-call trace). Pure — the whole point of extracting it here.
export function evalAssertion(a: Assertion, ctx: AssertionContext): AssertionResult {
  const type = String(a.type ?? '').toLowerCase()
  const docs = ctx.docs ?? []
  const text = ctx.text ?? ''
  const trace = ctx.trace ?? []
  const callsTo = (tool: string) => trace.filter((c) => c.name.toLowerCase() === tool.toLowerCase())
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
    // --- tool-usage assertions (graded against the trace) ---
    case 'calls_tool': {
      const tool = String(a.tool ?? '').trim()
      const hit = tool !== '' && callsTo(tool).length > 0
      return { type, pass: hit, detail: hit ? `called ${tool}` : `did not call ${tool || '(no tool given)'}` }
    }
    case 'not_calls_tool': {
      const tool = String(a.tool ?? '').trim()
      const called = tool !== '' && callsTo(tool).length > 0
      return { type, pass: !called, detail: called ? `unexpectedly called ${tool}` : `did not call ${tool} (as expected)` }
    }
    case 'calls_tool_with': {
      const tool = String(a.tool ?? '').trim()
      const matches = callsTo(tool)
      if (tool === '' || matches.length === 0) {
        return { type, pass: false, detail: `did not call ${tool || '(no tool given)'}` }
      }
      const argContains = a.arg_contains != null ? String(a.arg_contains).toLowerCase() : null
      const argRegex = a.arg_regex != null ? String(a.arg_regex) : null
      if (argContains == null && argRegex == null) {
        return { type, pass: true, detail: `called ${tool}` }
      }
      const hit = matches.some((c) => {
        const argStr = JSON.stringify(c.arguments ?? {})
        if (argContains != null && !argStr.toLowerCase().includes(argContains)) return false
        if (argRegex != null) {
          try {
            if (!new RegExp(argRegex, 'i').test(argStr)) return false
          } catch {
            return false
          }
        }
        return true
      })
      const want = argContains != null ? `args containing "${a.arg_contains}"` : `args matching /${a.arg_regex}/`
      return { type, pass: hit, detail: hit ? `called ${tool} with ${want}` : `called ${tool} but not with ${want}` }
    }
    case 'tool_call_count': {
      const tool = String(a.tool ?? '').trim()
      const n = tool === '' ? 0 : callsTo(tool).length
      const has = (k: string) => a[k] != null && a[k] !== ''
      let pass = true
      const bounds: string[] = []
      if (has('equals')) { const e = Number(a.equals); pass = pass && n === e; bounds.push(`= ${e}`) }
      if (has('max')) { const m = Number(a.max); pass = pass && n <= m; bounds.push(`≤ ${m}`) }
      if (has('min')) { const m = Number(a.min); pass = pass && n >= m; bounds.push(`≥ ${m}`) }
      if (bounds.length === 0) { pass = n > 0; bounds.push('≥ 1') }
      return { type, pass, detail: `${tool} called ${n}× (want ${bounds.join(', ')})` }
    }
    default:
      return { type: type || 'unknown', pass: false, detail: `unsupported assertion type "${a.type}"` }
  }
}

// Compact one-line render of a tool trace for storing on a result / showing in MCP.
export function summarizeTrace(trace: ToolCall[]): string {
  if (!trace.length) return '(no tools called)'
  return trace
    .map((c) => {
      const args = JSON.stringify(c.arguments ?? {})
      const shortArgs = args.length > 80 ? args.slice(0, 80) + '…' : args
      return `${c.name}(${shortArgs})${c.sandboxed ? ' [sandboxed]' : ''}`
    })
    .join('; ')
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

// Per-case breakdown for one run — the "what actually happened" payload MCP shows
// when you pass a run_id: each case's pass/fail, the tools it called, the failed
// assertions, and the judge's reason. This is what makes tool usage MEASURABLE
// over MCP (not just a headline score). `results` are eval_results rows.
// deno-lint-ignore no-explicit-any
export function formatRunDetail(run: any, results: any[]): string {
  const header = formatEvalRun(run)
  if (!results.length) return `${header}\n\n(no case results yet)`
  const lines = results.map((r) => {
    const mark = r.passed ? '✓' : '✗'
    const parts = [`${mark} ${r.case_name}`]
    const detail = r.detail ?? {}
    // Tools called (chat/agent trace or the tool-target invocation).
    const tools = Array.isArray(detail.tools) ? (detail.tools as ToolCall[]) : []
    if (tools.length) parts.push(`    tools: ${summarizeTrace(tools)}`)
    // Failed assertions.
    const asserts = Array.isArray(detail.assertions) ? (detail.assertions as AssertionResult[]) : []
    const failed = asserts.filter((a) => !a.pass)
    if (failed.length) parts.push(`    failed: ${failed.map((a) => `${a.type} (${a.detail})`).join('; ')}`)
    // Judge reason on a fail.
    if (detail.judge && !detail.judge.pass && detail.judge.reason) parts.push(`    judge: ${detail.judge.reason}`)
    return parts.join('\n')
  })
  return `${header}\n\nCases:\n${lines.join('\n')}`
}
