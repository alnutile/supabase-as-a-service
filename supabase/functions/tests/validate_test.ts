// deno test — webhook deterministic-mode payload validation. On that path no
// model runs, so this validation IS the security gate; keep it covered.
import { assertEquals } from 'jsr:@std/assert@1'
import { jsonType, validatePayload } from '../_shared/validate.ts'

const schema = {
  properties: {
    email: { type: 'string' },
    count: { type: 'integer' },
    price: { type: 'number' },
    tags: { type: 'array' },
    meta: { type: 'object' },
    ok: { type: 'boolean' },
  },
  required: ['email'],
}

Deno.test('accepts a valid payload', () => {
  assertEquals(
    validatePayload(schema, { email: 'a@b.c', count: 2, price: 9.5, tags: [], meta: {}, ok: true }),
    [],
  )
})

Deno.test('rejects non-object payloads outright', () => {
  assertEquals(validatePayload(schema, 'hi'), ['payload must be a JSON object'])
  assertEquals(validatePayload(schema, [1]), ['payload must be a JSON object'])
  assertEquals(validatePayload(schema, null), ['payload must be a JSON object'])
})

Deno.test('flags missing and null required fields', () => {
  assertEquals(validatePayload(schema, {}), ['missing required field "email"'])
  assertEquals(validatePayload(schema, { email: null }), ['missing required field "email"'])
})

Deno.test('type-checks declared properties', () => {
  assertEquals(validatePayload(schema, { email: 5 }), ['field "email" should be string, got number'])
  assertEquals(validatePayload(schema, { email: 'a', count: 1.5 }), [
    'field "count" should be integer, got number',
  ])
  assertEquals(validatePayload(schema, { email: 'a', tags: {} }), [
    'field "tags" should be array, got object',
  ])
})

Deno.test('integer accepts whole numbers; number accepts floats', () => {
  assertEquals(validatePayload(schema, { email: 'a', count: 3, price: 3 }), [])
  assertEquals(validatePayload(schema, { email: 'a', price: 3.14 }), [])
})

Deno.test('undeclared fields pass through; empty schema only requires an object', () => {
  assertEquals(validatePayload(schema, { email: 'a', extra: 'whatever' }), [])
  assertEquals(validatePayload({}, { anything: true }), [])
})

Deno.test('jsonType distinguishes array/null/object', () => {
  assertEquals(jsonType([]), 'array')
  assertEquals(jsonType(null), 'null')
  assertEquals(jsonType({}), 'object')
  assertEquals(jsonType(1), 'number')
})
