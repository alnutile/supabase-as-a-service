// deno test — the model-error humanizer. OpenRouter returns a nested JSON blob
// on failures; describeModelError must pull the real message out so chat/webhook/
// scheduler surface a legible line instead of a "crazy error".
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { describeModelError } from '../_shared/errors.ts'

Deno.test('extracts the message from an OpenRouter { error: { message } } blob', () => {
  const body = JSON.stringify({ error: { message: 'This model is not available', code: 404 } })
  assertEquals(describeModelError(404, body), 'Model not found (404): This model is not available')
})

Deno.test('labels the well-known statuses', () => {
  assertStringIncludes(describeModelError(429, '{"error":{"message":"over limit"}}'), 'Rate limited (429):')
  assertStringIncludes(describeModelError(401, '{"error":{"message":"bad key"}}'), 'Auth failed (401):')
  assertStringIncludes(describeModelError(402, '{"error":{"message":"no credits"}}'), 'Payment/credits required (402):')
  assertStringIncludes(describeModelError(500, '{"error":{"message":"boom"}}'), 'Upstream model error (500):')
})

Deno.test('digs into a provider error nested under metadata.raw', () => {
  const body = JSON.stringify({
    error: {
      message: 'Provider returned error',
      code: 400,
      metadata: { raw: JSON.stringify({ error: { message: 'context length exceeded' } }) },
    },
  })
  // The most specific nested message wins over the generic wrapper.
  assertEquals(describeModelError(400, body), 'Bad request (400): context length exceeded')
})

Deno.test('falls back to metadata.raw string when it is not JSON', () => {
  const body = JSON.stringify({ error: { message: 'wrapper', metadata: { raw: 'plain provider text' } } })
  assertEquals(describeModelError(400, body), 'Bad request (400): plain provider text')
})

Deno.test('handles our own { error: "…" } edge-function bodies', () => {
  assertEquals(describeModelError(400, '{"error":"`messages` must be a non-empty array"}'), 'Bad request (400): `messages` must be a non-empty array')
})

Deno.test('non-JSON bodies are passed through (truncated)', () => {
  assertEquals(describeModelError(502, 'Bad Gateway'), 'Upstream model error (502): Bad Gateway')
  assertEquals(describeModelError(500, ''), 'Upstream model error (500): no response body')
})

Deno.test('caps the total length at 500 chars', () => {
  const long = JSON.stringify({ error: { message: 'x'.repeat(2000) } })
  assertEquals(describeModelError(500, long).length, 500)
})
