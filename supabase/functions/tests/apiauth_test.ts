// deno test — bearer-token parsing shared by the token-gated REST functions
// (artifacts, todos, run-tool). parseBearer is the pure half of auth; the
// mcp_token/JWT resolution in resolveApiUser needs a live DB, so only the
// parsing is unit-covered here.
import { assertEquals } from 'jsr:@std/assert@1'
import { parseBearer } from '../_shared/apiauth.ts'

Deno.test('strips a "Bearer " prefix (any case) and trims', () => {
  assertEquals(parseBearer('Bearer abc123'), 'abc123')
  assertEquals(parseBearer('bearer abc123'), 'abc123')
  assertEquals(parseBearer('BEARER   abc123'), 'abc123')
  assertEquals(parseBearer('  Bearer abc123  '), 'abc123')
})

Deno.test('accepts a bare token with no Bearer prefix', () => {
  assertEquals(parseBearer('abc123'), 'abc123')
  assertEquals(parseBearer('  abc123  '), 'abc123')
})

Deno.test('returns empty string for missing / empty headers', () => {
  assertEquals(parseBearer(null), '')
  assertEquals(parseBearer(undefined), '')
  assertEquals(parseBearer(''), '')
  assertEquals(parseBearer('Bearer '), '')
  assertEquals(parseBearer('   '), '')
})

Deno.test('does not strip an inner "bearer" substring of the token', () => {
  // Only a leading Bearer keyword is removed; a token that merely contains the
  // word is preserved.
  assertEquals(parseBearer('Bearer my-bearer-token'), 'my-bearer-token')
})
