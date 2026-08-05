// deno test — the pure helpers for the OUTBOUND MCP OAuth *client* (the workspace
// connecting to an OAuth-protected external MCP server). The security- and
// correctness-critical bits — WWW-Authenticate parsing, metadata URL derivation,
// expiry math, and authorize-URL building — are covered here rather than left to
// the wired-up edge functions (which need a live external server to exercise).
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import {
  authServerMetadataUrls,
  buildAuthorizeUrl,
  computeExpiresAtIso,
  isAccessTokenExpired,
  parseResourceMetadataUrl,
  protectedResourceMetadataUrl,
} from '../_shared/mcp_oauth.ts'
import { pkceChallengeS256, verifyPkceS256 } from '../_shared/oauth.ts'

Deno.test('parseResourceMetadataUrl extracts the quoted pointer', () => {
  assertEquals(
    parseResourceMetadataUrl('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'),
    'https://mcp.example.com/.well-known/oauth-protected-resource',
  )
})

Deno.test('parseResourceMetadataUrl handles unquoted + extra params', () => {
  assertEquals(
    parseResourceMetadataUrl('Bearer error="invalid_token", resource_metadata=https://x.test/rm'),
    'https://x.test/rm',
  )
})

Deno.test('parseResourceMetadataUrl returns null when absent', () => {
  assertEquals(parseResourceMetadataUrl('Bearer realm="x"'), null)
  assertEquals(parseResourceMetadataUrl(null), null)
  assertEquals(parseResourceMetadataUrl(''), null)
})

Deno.test('authServerMetadataUrls: path issuer yields RFC 8414 path-inserted form first', () => {
  const urls = authServerMetadataUrls('https://auth.example.com/tenant1')
  assert(urls.includes('https://auth.example.com/.well-known/oauth-authorization-server/tenant1'))
  assert(urls.includes('https://auth.example.com/tenant1/.well-known/oauth-authorization-server'))
  assert(urls.includes('https://auth.example.com/.well-known/oauth-authorization-server'))
  // No duplicates.
  assertEquals(urls.length, new Set(urls).size)
})

Deno.test('authServerMetadataUrls: root issuer', () => {
  const urls = authServerMetadataUrls('https://auth.example.com')
  assert(urls.includes('https://auth.example.com/.well-known/oauth-authorization-server'))
  assert(urls.includes('https://auth.example.com/.well-known/openid-configuration'))
})

Deno.test('authServerMetadataUrls: garbage in → empty out', () => {
  assertEquals(authServerMetadataUrls('not a url'), [])
})

Deno.test('protectedResourceMetadataUrl uses the origin', () => {
  assertEquals(
    protectedResourceMetadataUrl('https://mcp.example.com/mcp'),
    'https://mcp.example.com/.well-known/oauth-protected-resource',
  )
  assertEquals(protectedResourceMetadataUrl('bad'), null)
})

Deno.test('computeExpiresAtIso: honors expires_in, defaults to 1h', () => {
  const now = 1_000_000_000_000
  assertEquals(computeExpiresAtIso(3600, now), new Date(now + 3600_000).toISOString())
  // Missing / non-positive → 1 hour fallback.
  assertEquals(computeExpiresAtIso(undefined, now), new Date(now + 3600_000).toISOString())
  assertEquals(computeExpiresAtIso(0, now), new Date(now + 3600_000).toISOString())
})

Deno.test('isAccessTokenExpired: missing expiry → treat as expired (refresh)', () => {
  assert(isAccessTokenExpired(null, Date.now()))
  assert(isAccessTokenExpired(undefined, Date.now()))
  assert(isAccessTokenExpired('not-a-date', Date.now()))
})

Deno.test('isAccessTokenExpired: skew window forces early refresh', () => {
  const now = 1_000_000_000_000
  const in30s = new Date(now + 30_000).toISOString()
  const in5m = new Date(now + 300_000).toISOString()
  assert(isAccessTokenExpired(in30s, now, 60)) // within 60s skew → expired
  assertFalse(isAccessTokenExpired(in5m, now, 60))
})

Deno.test('buildAuthorizeUrl includes PKCE S256 + resource indicator', () => {
  const u = new URL(
    buildAuthorizeUrl({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'abc',
      redirectUri: 'https://app.test/functions/v1/mcp-oauth-callback',
      codeChallenge: 'CHAL',
      state: 'STATE',
      scope: 'read write',
      resource: 'https://mcp.example.com/mcp',
    }),
  )
  assertEquals(u.searchParams.get('response_type'), 'code')
  assertEquals(u.searchParams.get('client_id'), 'abc')
  assertEquals(u.searchParams.get('code_challenge'), 'CHAL')
  assertEquals(u.searchParams.get('code_challenge_method'), 'S256')
  assertEquals(u.searchParams.get('state'), 'STATE')
  assertEquals(u.searchParams.get('scope'), 'read write')
  assertEquals(u.searchParams.get('resource'), 'https://mcp.example.com/mcp')
})

Deno.test('buildAuthorizeUrl omits empty scope/resource', () => {
  const u = new URL(
    buildAuthorizeUrl({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'abc',
      redirectUri: 'https://app.test/cb',
      codeChallenge: 'CHAL',
      state: 'STATE',
    }),
  )
  assertFalse(u.searchParams.has('scope'))
  assertFalse(u.searchParams.has('resource'))
})

Deno.test('PKCE round-trip: our challenge verifies against the shared verifier', async () => {
  // The client generates challenge = S256(verifier); a server checks it back.
  const verifier = 'a'.repeat(43)
  const challenge = await pkceChallengeS256(verifier)
  assert(await verifyPkceS256(verifier, challenge))
  assertFalse(await verifyPkceS256('b'.repeat(43), challenge))
})
