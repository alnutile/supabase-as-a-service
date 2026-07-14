// deno test — the pure, security-critical OAuth helpers for the MCP connector's
// authorization server. PKCE, redirect-uri matching, expiry, and request-shape
// validation are the bits an attacker probes, so they are covered here rather
// than left to the wired-up edge function (which needs a live Claude handshake).
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import {
  authorizeShapeError,
  authServerMetadata,
  buildRedirect,
  functionBaseUrl,
  isAllowedRedirectUri,
  isExpired,
  parseAuthorizeParams,
  protectedResourceMetadata,
  randomToken,
  timingSafeEqual,
  validateRedirectUri,
  verifyPkceS256,
} from '../_shared/oauth.ts'

// RFC 7636 Appendix B canonical S256 test vector.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

Deno.test('verifyPkceS256: accepts the RFC 7636 vector', async () => {
  assert(await verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE))
})

Deno.test('verifyPkceS256: rejects a wrong verifier', async () => {
  assertFalse(await verifyPkceS256(RFC_VERIFIER, 'not-the-challenge-aaaaaaaaaaaaaaaaaaaaaaaaa'))
  assertFalse(await verifyPkceS256('x'.repeat(43), RFC_CHALLENGE))
})

Deno.test('verifyPkceS256: rejects malformed / empty verifiers', async () => {
  assertFalse(await verifyPkceS256('', RFC_CHALLENGE))
  assertFalse(await verifyPkceS256('tooshort', RFC_CHALLENGE)) // < 43 chars
  assertFalse(await verifyPkceS256('a'.repeat(129), RFC_CHALLENGE)) // > 128 chars
  assertFalse(await verifyPkceS256(RFC_VERIFIER, ''))
})

Deno.test('timingSafeEqual: correct for equal / unequal / different-length', () => {
  assert(timingSafeEqual('abc', 'abc'))
  assertFalse(timingSafeEqual('abc', 'abd'))
  assertFalse(timingSafeEqual('abc', 'abcd'))
})

Deno.test('randomToken: url-safe, high-entropy, unique', () => {
  const a = randomToken()
  const b = randomToken()
  assert(a !== b)
  assert(a.length >= 43) // 32 bytes → 43 base64url chars
  assertFalse(/[^A-Za-z0-9_-]/.test(a)) // url-safe alphabet only
})

Deno.test('validateRedirectUri: exact-match only', () => {
  const reg = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/cb']
  assert(validateRedirectUri(reg, 'https://claude.ai/api/mcp/auth_callback'))
  assertFalse(validateRedirectUri(reg, 'https://claude.ai/api/mcp/auth_callback/evil'))
  assertFalse(validateRedirectUri(reg, 'https://evil.example/cb'))
  assertFalse(validateRedirectUri(reg, ''))
})

Deno.test('isAllowedRedirectUri: https + loopback + app schemes, not open http', () => {
  assert(isAllowedRedirectUri('https://claude.ai/cb'))
  assert(isAllowedRedirectUri('http://localhost:8976/cb'))
  assert(isAllowedRedirectUri('http://127.0.0.1:9000/cb'))
  assert(isAllowedRedirectUri('claude-desktop://oauth/cb'))
  assertFalse(isAllowedRedirectUri('http://evil.example/cb')) // open http rejected
  assertFalse(isAllowedRedirectUri('javascript:alert(1)'))
  assertFalse(isAllowedRedirectUri('not a url'))
})

Deno.test('isExpired: null never expires; past expires; bad = fail closed', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  assertFalse(isExpired(null, now))
  assertFalse(isExpired(undefined, now))
  assertFalse(isExpired('2026-01-01T00:01:00Z', now)) // 1 min in the future
  assert(isExpired('2025-12-31T23:59:00Z', now)) // past
  assert(isExpired('garbage', now)) // unparseable → expired
})

Deno.test('authorizeShapeError: enforces code + PKCE S256', () => {
  const ok = {
    responseType: 'code',
    clientId: 'c1',
    redirectUri: 'https://claude.ai/cb',
    codeChallenge: 'abc',
    codeChallengeMethod: 'S256',
    state: 's',
    scope: 'mcp',
    resource: 'https://h/functions/v1/mcp',
  }
  assertEquals(authorizeShapeError(ok), null)
  assertEquals(authorizeShapeError({ ...ok, responseType: 'token' }), 'unsupported_response_type')
  assertEquals(authorizeShapeError({ ...ok, clientId: '' }), 'invalid_request')
  assertEquals(authorizeShapeError({ ...ok, codeChallenge: '' }), 'invalid_request')
  assertEquals(authorizeShapeError({ ...ok, codeChallengeMethod: 'plain' }), 'invalid_request')
})

Deno.test('parseAuthorizeParams: reads all fields with empty-string defaults', () => {
  const sp = new URLSearchParams(
    'response_type=code&client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=xyz&code_challenge_method=S256&state=st&scope=mcp',
  )
  const p = parseAuthorizeParams(sp)
  assertEquals(p.clientId, 'c1')
  assertEquals(p.redirectUri, 'https://claude.ai/cb')
  assertEquals(p.codeChallengeMethod, 'S256')
  assertEquals(p.resource, '') // absent → ''
})

Deno.test('buildRedirect: appends code+state, skips empties', () => {
  const url = buildRedirect('https://claude.ai/cb?x=1', { code: 'abc', state: 'st', error: '' })
  const u = new URL(url)
  assertEquals(u.searchParams.get('code'), 'abc')
  assertEquals(u.searchParams.get('state'), 'st')
  assertEquals(u.searchParams.get('x'), '1') // preserves existing query
  assertFalse(u.searchParams.has('error')) // empty skipped
})

Deno.test('functionBaseUrl: always yields the public https /functions/v1/<segment> URL', () => {
  assertEquals(
    functionBaseUrl('https://abc.supabase.co/functions/v1/mcp-oauth/authorize?x=1', 'mcp-oauth'),
    'https://abc.supabase.co/functions/v1/mcp-oauth',
  )
  assertEquals(
    functionBaseUrl('https://mcp.acme.com/functions/v1/mcp/.well-known/oauth-protected-resource', 'mcp'),
    'https://mcp.acme.com/functions/v1/mcp',
  )
})

Deno.test('functionBaseUrl: repairs the Supabase-internal request shape (http + stripped prefix)', () => {
  // Inside the edge runtime req.url is http://<host>/<segment>/… — /functions/v1 stripped,
  // scheme http. Both must be repaired or OAuth discovery advertises unreachable URLs.
  assertEquals(
    functionBaseUrl('http://ref.supabase.co/mcp/.well-known/oauth-protected-resource', 'mcp'),
    'https://ref.supabase.co/functions/v1/mcp',
  )
  assertEquals(
    functionBaseUrl('http://ref.supabase.co/mcp-oauth/authorize?code_challenge=x', 'mcp-oauth'),
    'https://ref.supabase.co/functions/v1/mcp-oauth',
  )
})

Deno.test('metadata builders: endpoints derive from issuer / resource', () => {
  const issuer = 'https://h/functions/v1/mcp-oauth'
  const as = authServerMetadata(issuer)
  assertEquals(as.authorization_endpoint, `${issuer}/authorize`)
  assertEquals(as.token_endpoint, `${issuer}/token`)
  assertEquals(as.registration_endpoint, `${issuer}/register`)
  assertEquals(as.code_challenge_methods_supported, ['S256'])

  const prm = protectedResourceMetadata('https://h/functions/v1/mcp', issuer)
  assertEquals(prm.resource, 'https://h/functions/v1/mcp')
  assertEquals(prm.authorization_servers, [issuer])
})
