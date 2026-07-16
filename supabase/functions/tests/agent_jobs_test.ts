// deno test — the pure capability-worker-job helpers (validation, manifest
// normalization, idempotency, backoff, summaries). Kept pure so both the in-app
// builtins and the standalone Railway workers share the exact job contract with
// no mocks.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  backoffSeconds,
  buildIdempotencyKey,
  capabilityForOperation,
  clampPriority,
  isValidOperation,
  manifestIds,
  nextFailureState,
  normalizeInputManifest,
  stableJson,
  summarizeJob,
  summarizeResult,
  validateOperation,
} from '../_shared/agent_jobs.ts'

Deno.test('capabilityForOperation: derives from prefix, rejects unknown', () => {
  assertEquals(capabilityForOperation('office.create_docx'), 'office')
  assertEquals(capabilityForOperation('media.probe'), 'media')
  assertEquals(capabilityForOperation('pdf.split'), null)
  assertEquals(capabilityForOperation(''), null)
})

Deno.test('isValidOperation: only allow-listed operations', () => {
  assertEquals(isValidOperation('office', 'office.create_docx'), true)
  assertEquals(isValidOperation('media', 'media.extract_frames'), true)
  assertEquals(isValidOperation('office', 'office.run_command'), false)
  assertEquals(isValidOperation('media', 'office.create_docx'), false)
})

Deno.test('validateOperation: catches capability/operation mismatch and unknowns', () => {
  assertEquals(validateOperation('office', 'office.create_docx'), null)
  assertStringIncludes(validateOperation('office', 'media.probe') ?? '', 'does not belong')
  assertStringIncludes(validateOperation('pdf', 'pdf.x') ?? '', 'Unknown capability')
  assertStringIncludes(validateOperation('office', 'office.run_command') ?? '', 'Unsupported operation')
  assertStringIncludes(validateOperation('office', '') ?? '', 'operation is required')
})

Deno.test('normalizeInputManifest: keeps locatable refs, defaults required=true', () => {
  const out = normalizeInputManifest([
    { file_id: ' abc ', role: 'template' },
    { artifact_id: 'art-1', required: false },
    { storage_path: 'ws/x.docx' },
    { role: 'orphan' }, // no locator → dropped
    'garbage',
  ])
  assertEquals(out.length, 3)
  assertEquals(out[0].file_id, 'abc')
  assertEquals(out[0].required, true)
  assertEquals(out[1].required, false)
  assertEquals(out[2].storage_path, 'ws/x.docx')
})

Deno.test('normalizeInputManifest: wraps a single object and handles null', () => {
  assertEquals(normalizeInputManifest(null).length, 0)
  assertEquals(normalizeInputManifest({ file_id: 'one' }).length, 1)
})

Deno.test('manifestIds: sorted + stable across order', () => {
  const a = manifestIds(normalizeInputManifest([{ file_id: 'b' }, { file_id: 'a' }]))
  const b = manifestIds(normalizeInputManifest([{ file_id: 'a' }, { file_id: 'b' }]))
  assertEquals(a, b)
  assertEquals(a, ['f:a', 'f:b'])
})

Deno.test('buildIdempotencyKey: identical requests match, different inputs differ', () => {
  const m1 = normalizeInputManifest([{ file_id: 'x' }, { file_id: 'y' }])
  const m2 = normalizeInputManifest([{ file_id: 'y' }, { file_id: 'x' }]) // reordered
  const k1 = buildIdempotencyKey({ operation: 'office.create_docx', manifest: m1, instructions: 'Make  a Proposal' })
  const k2 = buildIdempotencyKey({ operation: 'office.create_docx', manifest: m2, instructions: 'make a proposal' })
  assertEquals(k1, k2) // whitespace/case + input order normalized away
  const k3 = buildIdempotencyKey({ operation: 'office.create_docx', manifest: m1, instructions: 'different' })
  assertEquals(k1 === k3, false)
  assertStringIncludes(k1, 'office.create_docx:')
})

Deno.test('buildIdempotencyKey: parameters affect the key deterministically', () => {
  const m = normalizeInputManifest([{ file_id: 'v' }])
  const a = buildIdempotencyKey({ operation: 'media.extract_frames', manifest: m, parameters: { format: 'png', timestamps: [0, 5] } })
  const b = buildIdempotencyKey({ operation: 'media.extract_frames', manifest: m, parameters: { timestamps: [0, 5], format: 'png' } })
  assertEquals(a, b) // key order in parameters doesn't matter
  const c = buildIdempotencyKey({ operation: 'media.extract_frames', manifest: m, parameters: { format: 'jpg', timestamps: [0, 5] } })
  assertEquals(a === c, false)
})

Deno.test('stableJson: sorts object keys recursively', () => {
  assertEquals(stableJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
})

Deno.test('backoffSeconds: 30s → 2m → 10m then capped', () => {
  assertEquals(backoffSeconds(1), 30)
  assertEquals(backoffSeconds(2), 120)
  assertEquals(backoffSeconds(3), 600)
  assertEquals(backoffSeconds(9), 600)
})

Deno.test('nextFailureState: permanent → failed, no retry', () => {
  assertEquals(nextFailureState(1, 3, true), { status: 'failed', retryInSeconds: null })
})

Deno.test('nextFailureState: transient under max_attempts → retrying with backoff', () => {
  assertEquals(nextFailureState(1, 3, false), { status: 'retrying', retryInSeconds: 30 })
  assertEquals(nextFailureState(2, 3, false), { status: 'retrying', retryInSeconds: 120 })
})

Deno.test('nextFailureState: transient at/over max_attempts → dead_letter', () => {
  assertEquals(nextFailureState(3, 3, false), { status: 'dead_letter', retryInSeconds: null })
  assertEquals(nextFailureState(5, 3, false), { status: 'dead_letter', retryInSeconds: null })
})

Deno.test('clampPriority: clamps to 0-100, defaults on garbage', () => {
  assertEquals(clampPriority(50), 50)
  assertEquals(clampPriority(-5), 0)
  assertEquals(clampPriority(999), 100)
  assertEquals(clampPriority('nope'), 50)
})

Deno.test('summarizeResult: renders files + artifacts, handles empty', () => {
  assertStringIncludes(summarizeResult([]), 'No output files')
  const out = summarizeResult([
    { file_id: 'f1', role: 'editable_document', filename: 'a.docx' },
    { artifact_id: 'a1', type: 'artifact', role: 'validation_report' },
  ])
  assertStringIncludes(out, 'a.docx')
  assertStringIncludes(out, '[editable_document]')
  assertStringIncludes(out, 'artifact')
})

Deno.test('summarizeJob: shows status/attempts and outputs when completed', () => {
  const running = summarizeJob({ id: 'j1', operation: 'media.probe', status: 'running', attempts: 1, max_attempts: 3 })
  assertStringIncludes(running, 'attempt 1/3')
  const done = summarizeJob({
    id: 'j2',
    operation: 'office.create_docx',
    status: 'completed',
    result_manifest: [{ file_id: 'f', filename: 'x.docx' }],
  })
  assertStringIncludes(done, 'outputs:')
  assertStringIncludes(done, 'x.docx')
})
