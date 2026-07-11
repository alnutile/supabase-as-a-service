// deno test — the pure eval helpers (evalAssertion / parseModels / formatMatrix /
// formatEvalRun). No DB, no model — evals.ts lazy-imports the orchestrator/judge
// so importing it here (permission-free) never trips on their env reads.
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { evalAssertion, formatEvalRun, formatMatrix, MAX_MODELS, parseModels } from '../_shared/evals_pure.ts'

// --- evalAssertion ---------------------------------------------------------

Deno.test('evalAssertion: contains matches case-insensitively', () => {
  assert(evalAssertion({ type: 'contains', text: 'BLUE-OTTER' }, [], 'the codeword is blue-otter-49').pass)
  assert(!evalAssertion({ type: 'contains', text: 'missing' }, [], 'nope').pass)
})

Deno.test('evalAssertion: not_contains inverts', () => {
  assert(evalAssertion({ type: 'not_contains', text: 'secret' }, [], 'clean answer').pass)
  assert(!evalAssertion({ type: 'not_contains', text: 'secret' }, [], 'has a secret').pass)
})

Deno.test('evalAssertion: regex, with graceful invalid handling', () => {
  assert(evalAssertion({ type: 'regex', pattern: 'blue-\\w+' }, [], 'blue-otter').pass)
  const bad = evalAssertion({ type: 'regex', pattern: '(' }, [], 'x')
  assert(!bad.pass)
  assertStringIncludes(bad.detail, 'invalid regex')
})

Deno.test('evalAssertion: retrieves checks doc names', () => {
  assert(evalAssertion({ type: 'retrieves', doc: 'Nightjar' }, ['project nightjar.pdf', 'other.pdf'], '').pass)
  assert(!evalAssertion({ type: 'retrieves', doc: 'ghost' }, ['project nightjar.pdf'], '').pass)
})

Deno.test('evalAssertion: recall_at_k respects k window', () => {
  const docs = ['a', 'b', 'c', 'target']
  assert(!evalAssertion({ type: 'recall_at_k', doc: 'target', k: 2 }, docs, '').pass)
  assert(evalAssertion({ type: 'recall_at_k', doc: 'target', k: 4 }, docs, '').pass)
})

Deno.test('evalAssertion: unknown type fails closed', () => {
  const r = evalAssertion({ type: 'wat' }, [], 'anything')
  assert(!r.pass)
  assertStringIncludes(r.detail, 'unsupported')
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
