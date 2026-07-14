// Pure, framework-free OAuth 2.1 (+ PKCE) helpers for the workspace MCP
// connector. Shared by the authorization server (supabase/functions/mcp-oauth)
// and the resource server (supabase/functions/mcp). Deliberately free of Deno /
// Supabase imports so the security-critical bits — PKCE S256, redirect-uri
// matching, token expiry, request-shape validation — stay unit-tested in
// tests/oauth_test.ts.
//
// Why this exists: Claude's "Add custom connector" dialog speaks OAuth 2.1 with
// auto-discovery + Dynamic Client Registration, so a user can paste the
// workspace MCP URL and click Approve instead of copy-pasting a static token.

const encoder = new TextEncoder()

export function base64urlFromBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A high-entropy URL-safe opaque token (default 32 bytes → 256 bits). Used for
 *  authorization codes, refresh tokens and client ids. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return base64urlFromBytes(buf)
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return new Uint8Array(digest)
}

/** Constant-time string compare — avoids leaking match length/position. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** PKCE S256 (RFC 7636): does BASE64URL(SHA256(verifier)) === challenge?
 *  We ONLY support S256 — callers must reject a missing/`plain` method before
 *  reaching here. Returns false for a malformed verifier. */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier || !challenge) return false
  // RFC 7636 §4.1: verifier is 43–128 chars.
  if (verifier.length < 43 || verifier.length > 128) return false
  const computed = base64urlFromBytes(await sha256(verifier))
  return timingSafeEqual(computed, challenge)
}

/** null/undefined expiry = never expires (static tokens). A bad timestamp is
 *  treated as expired (fail closed). */
export function isExpired(expiresAtIso: string | null | undefined, nowMs: number): boolean {
  if (!expiresAtIso) return false
  const t = Date.parse(expiresAtIso)
  return Number.isNaN(t) ? true : t <= nowMs
}

export const AUTH_CODE_TTL_SEC = 300 // 5 minutes
export const ACCESS_TOKEN_TTL_SEC = 60 * 60 * 24 * 30 // 30 days

/** RFC 8414 Authorization Server Metadata for our AS at `issuer`. */
export function authServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  }
}

/** RFC 9728 Protected Resource Metadata for the MCP resource server. */
export function protectedResourceMetadata(resource: string, issuer: string) {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
  }
}

/** Exact-match the requested redirect_uri against the client's registered set.
 *  Exact-match (not prefix) is the confused-deputy defense for public clients. */
export function validateRedirectUri(registered: string[], given: string): boolean {
  if (!given) return false
  return registered.includes(given)
}

/** A registrable redirect target: https, or loopback/custom-scheme for native
 *  clients (Claude Desktop). Rejects plain http on non-loopback hosts. */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  // Custom app schemes (e.g. claude-desktop://…) are allowed for native clients.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && u.protocol !== 'javascript:' && u.protocol !== 'data:'
}

export interface AuthorizeParams {
  responseType: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  state: string
  scope: string
  resource: string
}

export function parseAuthorizeParams(sp: URLSearchParams): AuthorizeParams {
  return {
    responseType: sp.get('response_type') ?? '',
    clientId: sp.get('client_id') ?? '',
    redirectUri: sp.get('redirect_uri') ?? '',
    codeChallenge: sp.get('code_challenge') ?? '',
    codeChallengeMethod: sp.get('code_challenge_method') ?? '',
    state: sp.get('state') ?? '',
    scope: sp.get('scope') ?? '',
    resource: sp.get('resource') ?? '',
  }
}

/** Structural validation of an /authorize request that does NOT need the DB
 *  (client existence / redirect match are checked by the caller against
 *  oauth_clients). Returns an OAuth `error` code or null when acceptable. */
export function authorizeShapeError(p: AuthorizeParams): string | null {
  if (p.responseType !== 'code') return 'unsupported_response_type'
  if (!p.clientId) return 'invalid_request'
  if (!p.redirectUri) return 'invalid_request'
  if (!p.codeChallenge) return 'invalid_request'
  if (p.codeChallengeMethod !== 'S256') return 'invalid_request' // S256 only, never `plain`
  return null
}

/** Append query params to a redirect target (used for both success `code` and
 *  error redirects back to the client). Empty values are skipped. */
export function buildRedirect(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v)
  return u.toString()
}

/** The public base URL of one of our edge functions, e.g.
 *  `https://<host>/functions/v1/mcp-oauth`. Used to advertise every OAuth endpoint.
 *
 *  We CANNOT trust `req.url`: inside the Supabase edge runtime it is
 *  `http://<host>/<segment>/…` — the `/functions/v1` prefix is stripped and the
 *  scheme is the internal `http`. Echoing that back advertises an unreachable
 *  URL (wrong scheme, missing `/functions/v1`), which breaks OAuth discovery.
 *  So reconstruct the canonical public URL from the host: always `https`, always
 *  the `/functions/v1/<segment>` path Supabase serves functions under. */
export function functionBaseUrl(reqUrl: string, segment: string): string {
  const u = new URL(reqUrl)
  return `https://${u.host}/functions/v1/${segment}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The minimal, self-contained (no external assets — CSP-clean) login page shown
 *  at GET /authorize. It POSTs email+password back to /authorize along with the
 *  echoed OAuth params as hidden fields. Login delegates to the tenant's own
 *  Supabase Auth, so we never become the identity provider. */
export function renderLoginPage(opts: {
  actionPath: string
  hidden: Record<string, string>
  clientName?: string
  host: string
  error?: string
}): string {
  const hidden = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n      ')
  const who = opts.clientName ? escapeHtml(opts.clientName) : 'Claude'
  const err = opts.error
    ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Connect ${who}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0b0b0f; color: #e7e7ea; padding: 24px; }
    .card { width: 100%; max-width: 380px; background: #16161c; border: 1px solid #26262e;
      border-radius: 14px; padding: 28px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    p.sub { margin: 0 0 20px; color: #a0a0aa; font-size: 13px; }
    label { display: block; font-size: 12px; color: #a0a0aa; margin: 14px 0 6px; }
    input[type=email], input[type=password] { width: 100%; padding: 10px 12px; border-radius: 8px;
      border: 1px solid #33333d; background: #0f0f14; color: #e7e7ea; font-size: 14px; }
    button { width: 100%; margin-top: 20px; padding: 11px; border: 0; border-radius: 8px;
      background: #6d5efc; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #5b4df0; }
    .err { background: #3a1720; border: 1px solid #5a2230; color: #ffb4c0; padding: 9px 11px;
      border-radius: 8px; font-size: 13px; margin: 0 0 4px; }
    .host { color: #71717a; font-size: 11px; margin-top: 18px; text-align: center; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect ${who}</h1>
    <p class="sub">Sign in to your workspace to authorize access.</p>
    ${err}
    <form method="post" action="${escapeHtml(opts.actionPath)}">
      ${hidden}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in &amp; authorize</button>
    </form>
    <div class="host">${escapeHtml(opts.host)}</div>
  </div>
</body>
</html>`
}

/** A terminal HTML error page for when we must NOT redirect (bad client /
 *  redirect_uri) — showing the error to the human instead of an attacker-chosen
 *  URL. */
export function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0b0f;color:#e7e7ea;padding:24px}
.card{max-width:420px;background:#16161c;border:1px solid #26262e;border-radius:14px;padding:28px}
h1{font-size:17px;margin:0 0 8px}p{margin:0;color:#a0a0aa;font-size:14px}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></div></body></html>`
}
