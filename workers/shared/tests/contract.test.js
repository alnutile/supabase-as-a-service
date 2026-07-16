// Worker-side unit tests for the pure job contract, using Node's built-in test
// runner (no extra deps). Run with `npm test` in workers/shared (it builds first,
// then tests the compiled dist). Mirrors the Deno-side tests in
// supabase/functions/tests/agent_jobs_test.ts so both sides of the contract agree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backoffSeconds,
  isValidOperation,
  nextFailureState,
  ownsResource,
  CAPABILITY_OPERATIONS,
} from '../dist/contract.js'

test('isValidOperation: only allow-listed operations', () => {
  assert.equal(isValidOperation('office', 'office.create_docx'), true)
  assert.equal(isValidOperation('media', 'media.extract_frames'), true)
  assert.equal(isValidOperation('office', 'office.run_command'), false)
  assert.equal(isValidOperation('media', 'office.create_docx'), false)
})

test('capability operation sets are frozen expectations', () => {
  assert.deepEqual(CAPABILITY_OPERATIONS.office, [
    'office.inspect_document',
    'office.render_document',
    'office.create_docx',
    'office.convert_document',
  ])
  assert.equal(CAPABILITY_OPERATIONS.media.length, 6)
})

test('backoffSeconds: 30s → 2m → 10m then capped', () => {
  assert.equal(backoffSeconds(1), 30)
  assert.equal(backoffSeconds(2), 120)
  assert.equal(backoffSeconds(3), 600)
  assert.equal(backoffSeconds(9), 600)
})

test('nextFailureState: permanent → failed', () => {
  assert.deepEqual(nextFailureState(1, 3, true), { status: 'failed', retryInSeconds: null })
})

test('nextFailureState: transient under max → retrying with backoff', () => {
  assert.deepEqual(nextFailureState(1, 3, false), { status: 'retrying', retryInSeconds: 30 })
  assert.deepEqual(nextFailureState(2, 3, false), { status: 'retrying', retryInSeconds: 120 })
})

test('nextFailureState: transient at/over max → dead_letter', () => {
  assert.deepEqual(nextFailureState(3, 3, false), { status: 'dead_letter', retryInSeconds: null })
})

test('ownsResource: enforces tenant isolation', () => {
  assert.equal(ownsResource('u1', 'u1'), true)
  assert.equal(ownsResource('u1', 'u2'), false)
  assert.equal(ownsResource('u1', null), false)
  assert.equal(ownsResource('u1', undefined), false)
})
