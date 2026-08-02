// deno test — the pure `clip` helper (bounds stored trace text). No DB/npm.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { clip } from '../_shared/run_recorder_pure.ts'

Deno.test('clip: passes short strings through unchanged', () => {
  assertEquals(clip('hello'), 'hello')
  assertEquals(clip(''), '')
})

Deno.test('clip: truncates past the limit and notes the remainder', () => {
  const out = clip('a'.repeat(50), 10)
  assertStringIncludes(out, 'aaaaaaaaaa')
  assertStringIncludes(out, '40 more chars')
  // prefix is exactly the limit
  assertEquals(out.startsWith('a'.repeat(10)), true)
})

Deno.test('clip: coerces non-strings and handles null/undefined', () => {
  assertEquals(clip(42), '42')
  assertEquals(clip(null), '')
  assertEquals(clip(undefined), '')
})
