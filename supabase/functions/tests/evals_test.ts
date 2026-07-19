// deno test — the pure eval helpers (evalAssertion / parseModels / formatMatrix /
// formatEvalRun). No DB, no model — evals.ts lazy-imports the orchestrator/judge
// so importing it here (permission-free) never trips on their env reads.
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  evalAssertion,
  formatEvalRun,
  formatMatrix,
  formatRunDetail,
  isReadOnlyBuiltin,
  MAX_MODELS,
  parseModels,
  summarizeTrace,
  type ToolCall,
} from '../_shared/evals_pure.ts'

// --- evalAssertion: text + retrieval ---------------------------------------

Deno.test('evalAssertion: contains matches case-insensitively', () => {
  assert(evalAssertion({ type: 'contains', text: 'BLUE-OTTER' }, { text: 'the codeword is blue-otter-49' }).pass)
  assert(!evalAssertion({ type: 'contains', text: 'missing' }, { text: 'nope' }).pass)
})

Deno.test('evalAssertion: not_contains inverts', () => {
  assert(evalAssertion({ type: 'not_contains', text: 'secret' }, { text: 'clean answer' }).pass)
  assert(!evalAssertion({ type: 'not_contains', text: 'secret' }, { text: 'has a secret' }).pass)
})

Deno.test('evalAssertion: regex, with graceful invalid handling', () => {
  assert(evalAssertion({ type: 'regex', pattern: 'blue-\\w+' }, { text: 'blue-otter' }).pass)
  const bad = evalAssertion({ type: 'regex', pattern: '(' }, { text: 'x' })
  assert(!bad.pass)
  assertStringIncludes(bad.detail, 'invalid regex')
})

Deno.test('evalAssertion: retrieves checks doc names', () => {
  assert(evalAssertion({ type: 'retrieves', doc: 'Nightjar' }, { docs: ['project nightjar.pdf', 'other.pdf'] }).pass)
  assert(!evalAssertion({ type: 'retrieves', doc: 'ghost' }, { docs: ['project nightjar.pdf'] }).pass)
})

Deno.test('evalAssertion: recall_at_k respects k window', () => {
  const docs = ['a', 'b', 'c', 'target']
  assert(!evalAssertion({ type: 'recall_at_k', doc: 'target', k: 2 }, { docs }).pass)
  assert(evalAssertion({ type: 'recall_at_k', doc: 'target', k: 4 }, { docs }).pass)
})

Deno.test('evalAssertion: unknown type fails closed', () => {
  const r = evalAssertion({ type: 'wat' }, { text: 'anything' })
  assert(!r.pass)
  assertStringIncludes(r.detail, 'unsupported')
})

// --- evalAssertion: tool-usage ---------------------------------------------

const trace: ToolCall[] = [
  { name: 'search_documents', arguments: { query: 'insurance expiry' } },
  { name: 'create_todo', arguments: { title: 'Reconfirm Summit insurance' }, sandboxed: true },
]

Deno.test('evalAssertion: calls_tool / not_calls_tool', () => {
  assert(evalAssertion({ type: 'calls_tool', tool: 'search_documents' }, { trace }).pass)
  assert(!evalAssertion({ type: 'calls_tool', tool: 'send_email' }, { trace }).pass)
  assert(evalAssertion({ type: 'not_calls_tool', tool: 'send_email' }, { trace }).pass)
  assert(!evalAssertion({ type: 'not_calls_tool', tool: 'create_todo' }, { trace }).pass)
})

Deno.test('evalAssertion: calls_tool_with matches arguments', () => {
  assert(evalAssertion({ type: 'calls_tool_with', tool: 'create_todo', arg_contains: 'insurance' }, { trace }).pass)
  assert(!evalAssertion({ type: 'calls_tool_with', tool: 'create_todo', arg_contains: 'nope' }, { trace }).pass)
  assert(evalAssertion({ type: 'calls_tool_with', tool: 'create_todo', arg_regex: 'Summit\\s+insurance' }, { trace }).pass)
  // no arg filter → behaves like calls_tool
  assert(evalAssertion({ type: 'calls_tool_with', tool: 'search_documents' }, { trace }).pass)
})

Deno.test('evalAssertion: tool_call_count bounds', () => {
  assert(evalAssertion({ type: 'tool_call_count', tool: 'search_documents', max: 1 }, { trace }).pass)
  assert(!evalAssertion({ type: 'tool_call_count', tool: 'search_documents', equals: 2 }, { trace }).pass)
  // default (no bound) means "at least once"
  assert(evalAssertion({ type: 'tool_call_count', tool: 'create_todo' }, { trace }).pass)
  assert(!evalAssertion({ type: 'tool_call_count', tool: 'never_called' }, { trace }).pass)
})

// --- sandbox classifier ----------------------------------------------------

Deno.test('isReadOnlyBuiltin: reads run, writes/secrets do not', () => {
  for (const n of ['search_documents', 'list_todos', 'get_artifact', 'query_table', 'check_email']) {
    assert(isReadOnlyBuiltin(n), `${n} should be read-only`)
  }
  for (const n of ['create_todo', 'send_email', 'update_artifact', 'delete_file', 'get_secret', 'remember']) {
    assert(!isReadOnlyBuiltin(n), `${n} should NOT be read-only`)
  }
})

Deno.test('summarizeTrace: renders names + sandbox marker', () => {
  assertEquals(summarizeTrace([]), '(no tools called)')
  const out = summarizeTrace(trace)
  assertStringIncludes(out, 'search_documents(')
  assertStringIncludes(out, 'create_todo(')
  assertStringIncludes(out, '[sandboxed]')
})

// --- parseModels -----------------------------------------------------------

Deno.test('parseModels: empty inputs → single default run', () => {
  assertEquals(parseModels(undefined), [null])
  assertEquals(parseModels(''), [null])
  assertEquals(parseModels([]), [null])
  assertEquals(parseModels('  ,  '), [null])
})

Deno.test('parseModels: comma/newline string → list', () => {
  assertEquals(parseModels('a/b, c/d\ne/f'), ['a/b', 'c/d', 'e/f'])
})

Deno.test('parseModels: array is trimmed + de-duped', () => {
  assertEquals(parseModels(['a/b', ' a/b ', 'c/d']), ['a/b', 'c/d'])
})

Deno.test('parseModels: clamps to MAX_MODELS', () => {
  const many = Array.from({ length: MAX_MODELS + 4 }, (_, i) => `m/${i}`)
  assertEquals(parseModels(many).length, MAX_MODELS)
})

// --- formatMatrix ----------------------------------------------------------

Deno.test('formatMatrix: sorts best score first + flags running', () => {
  const out = formatMatrix([
    { model: 'a/b', status: 'done', score: 0.5, passed: 1, total: 2, cost: 0.01 },
    { model: 'c/d', status: 'done', score: 0.9, passed: 9, total: 10, cost: 0.02 },
    { model: null, status: 'running', score: null, passed: 0, total: 3, cost: null },
  ])
  // Winner (90%) appears before the 50% row.
  assert(out.indexOf('c/d') < out.indexOf('a/b'))
  assertStringIncludes(out, 'profile default: running…')
  assertStringIncludes(out, 'still going')
})

Deno.test('formatMatrix: empty → no runs', () => {
  assertEquals(formatMatrix([]), 'No runs yet.')
})

// --- formatEvalRun ---------------------------------------------------------

Deno.test('formatEvalRun: renders score + model + cost', () => {
  const out = formatEvalRun({ id: 'r1', status: 'done', model: 'a/b', score: 0.75, passed: 3, total: 4, cost: 0.0123 })
  assertStringIncludes(out, '75% (3/4 passed)')
  assertStringIncludes(out, 'Model: a/b')
  assertStringIncludes(out, '$0.0123')
})

Deno.test('formatEvalRun: running run nudges a re-poll; null model shows default', () => {
  const out = formatEvalRun({ id: 'r2', status: 'running', model: null, score: null, passed: 0, total: 5, cost: null })
  assertStringIncludes(out, 'Model: profile default')
  assertStringIncludes(out, 'check again')
})

// --- formatRunDetail -------------------------------------------------------

Deno.test('formatRunDetail: per-case tools + failures + judge reason', () => {
  const run = { id: 'r3', status: 'done', model: 'a/b', score: 0.5, passed: 1, total: 2, cost: 0.02 }
  const results = [
    {
      case_name: 'searches then answers', passed: true,
      detail: { assertions: [{ type: 'calls_tool', pass: true, detail: 'called search_documents' }], tools: trace, judge: { pass: true } },
    },
    {
      case_name: 'must not email', passed: false,
      detail: {
        assertions: [{ type: 'not_calls_tool', pass: false, detail: 'unexpectedly called send_email' }],
        tools: [{ name: 'send_email', arguments: { to: 'x@y.com' } }],
        judge: { pass: false, reason: 'leaked data' },
      },
    },
  ]
  const out = formatRunDetail(run, results)
  assertStringIncludes(out, '✓ searches then answers')
  assertStringIncludes(out, 'tools: search_documents(')
  assertStringIncludes(out, '✗ must not email')
  assertStringIncludes(out, 'failed: not_calls_tool')
  assertStringIncludes(out, 'judge: leaked data')
})

Deno.test('formatRunDetail: no results yet', () => {
  assertStringIncludes(formatRunDetail({ id: 'r4', status: 'running', passed: 0, total: 0, score: null }, []), 'no case results yet')
})
