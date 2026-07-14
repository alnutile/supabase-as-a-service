// Supabase Edge Function: `mcp-oauth` (PUBLIC — verify_jwt=false).
// The OAuth 2.1 (PKCE) authorization server for the workspace MCP connector.
// Claude's "Add custom connector" dialog discovers this server, dynamically
// registers, sends the user through /authorize (login delegated to the tenant's
// OWN Supabase Auth — we never become the identity provider), then exchanges the
// code at /token for a bearer access token. That access token is minted as an
// `mcp_tokens` row, so the `mcp` resource server's existing `token → owner_id`
// path works unchanged and static tokens keep working.
//
// Every endpoint URL is derived from the incoming request host (functionBaseUrl),
// so this "just works" on the tenant's own domain — *.supabase.co, a custom
// functions domain, or the future hosted proxy — with nothing hardcoded.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_CODE_TTL_SEC,
  authorizeShapeError,
  authServerMetadata,
  buildRedirect,
  functionBaseUrl,
  isAllowedRedirectUri,
  parseAuthorizeParams,
  randomToken,
  renderErrorPage,
  renderLoginPage,
  validateRedirectUri,
  verifyPkceS256,
} from '../_shared/oauth.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

function admin() {
  return createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}
type DB = ReturnType<typeof admin>

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } })
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } })
const NO_STORE = { 'Cache-Control': 'no-store' }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const url = new URL(req.url)
  const path = url.pathname
  const issuer = functionBaseUrl(req.url, 'mcp-oauth')

  if (req.method === 'GET' && path.endsWith('/.well-known/oauth-authorization-server')) {
    return json(authServerMetadata(issuer))
  }
  if (req.method === 'POST' && path.endsWith('/register')) return register(req)
  if (path.endsWith('/authorize')) {
    return req.method === 'POST' ? authorizePost(req, issuer) : authorizeGet(req, issuer)
  }
  if (req.method === 'POST' && path.endsWith('/token')) return token(req)

  return json({ error: 'not_found' }, 404)
})

// --- Dynamic Client Registration (RFC 7591) ---
async function register(req: Request): Promise<Response> {
  let body: { redirect_uris?: unknown; client_name?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_client_metadata' }, 400)
  }
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
  if (uris.length === 0 || !uris.every(isAllowedRedirectUri)) {
    return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, loopback, or an app scheme' }, 400)
  }
  const clientName = typeof body?.client_name === 'string' ? body.client_name.slice(0, 200) : null
  const clientId = `oauth_${randomToken(24)}`
  const { error } = await admin().from('oauth_clients').insert({ client_id: clientId, client_name: clientName, redirect_uris: uris })
  if (error) return json({ error: 'server_error' }, 500)
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: clientName ?? undefined,
    },
    201,
  )
}

// --- Authorization endpoint (GET renders login; POST processes it) ---
async function loadClient(db: DB, clientId: string) {
  if (!clientId) return null
  const { data } = await db.from('oauth_clients').select('client_id, client_name, redirect_uris').eq('client_id', clientId).maybeSingle()
  return data as { client_id: string; client_name: string | null; redirect_uris: string[] } | null
}

const hiddenFields = (p: ReturnType<typeof parseAuthorizeParams>) => ({
  response_type: p.responseType,
  client_id: p.clientId,
  redirect_uri: p.redirectUri,
  code_challenge: p.codeChallenge,
  code_challenge_method: p.codeChallengeMethod,
  state: p.state,
  scope: p.scope,
  resource: p.resource,
})

async function authorizeGet(req: Request, issuer: string): Promise<Response> {
  const p = parseAuthorizeParams(new URL(req.url).searchParams)
  const db = admin()
  const client = await loadClient(db, p.clientId)
  // Never redirect to an unvalidated URI — a bad client/redirect gets a terminal page.
  if (!client) return html(renderErrorPage('Unknown connector', 'This connector is not registered. Try adding it again.'), 400)
  if (!validateRedirectUri(client.redirect_uris ?? [], p.redirectUri)) {
    return html(renderErrorPage('Invalid redirect', 'The redirect URL does not match this connector.'), 400)
  }
  // From here the redirect_uri is trusted, so shape errors can bounce back to it.
  const shapeErr = authorizeShapeError(p)
  if (shapeErr) return Response.redirect(buildRedirect(p.redirectUri, { error: shapeErr, state: p.state }), 302)

  return html(
    renderLoginPage({
      actionPath: `${issuer}/authorize`,
      clientName: client.client_name ?? undefined,
      host: new URL(issuer).host,
      hidden: hiddenFields(p),
    }),
  )
}

async function authorizePost(req: Request, issuer: string): Promise<Response> {
  const form = await req.formData()
  const g = (k: string) => (form.get(k) ?? '').toString()
  const sp = new URLSearchParams()
  for (const k of AUTHORIZE_FIELDS) sp.set(k, g(k))
  const p = parseAuthorizeParams(sp)
  const db = admin()
  const client = await loadClient(db, p.clientId)
  if (!client) return html(renderErrorPage('Unknown connector', 'This connector is not registered.'), 400)
  if (!validateRedirectUri(client.redirect_uris ?? [], p.redirectUri)) {
    return html(renderErrorPage('Invalid redirect', 'The redirect URL does not match this connector.'), 400)
  }
  const shapeErr = authorizeShapeError(p)
  if (shapeErr) return Response.redirect(buildRedirect(p.redirectUri, { error: shapeErr, state: p.state }), 302)

  // Authenticate against the tenant's OWN Supabase Auth (password grant). We never
  // store the credential — we only learn who the user is.
  const userId = await passwordGrantUserId(g('email'), g('password'))
  if (!userId) {
    return html(
      renderLoginPage({
        actionPath: `${issuer}/authorize`,
        clientName: client.client_name ?? undefined,
        host: new URL(issuer).host,
        error: 'Incorrect email or password.',
        hidden: hiddenFields(p),
      }),
      401,
    )
  }

  const code = randomToken(32)
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000).toISOString()
  const { error } = await db.from('oauth_authorization_codes').insert({
    code,
    client_id: p.clientId,
    owner_id: userId,
    redirect_uri: p.redirectUri,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    resource: p.resource || null,
    scope: p.scope || null,
    expires_at: expiresAt,
  })
  if (error) return html(renderErrorPage('Server error', 'Could not complete authorization.'), 500)
  return Response.redirect(buildRedirect(p.redirectUri, { code, state: p.state }), 302)
}

const AUTHORIZE_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
]

async function passwordGrantUserId(email: string, password: string): Promise<string | null> {
  if (!email || !password) return null
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON },
      body: JSON.stringify({ email, password }),
    })
    if (!r.ok) return null
    const j = await r.json()
    return (j?.user?.id as string) ?? null
  } catch {
    return null
  }
}

// --- Token endpoint (authorization_code + refresh_token grants) ---
async function readForm(req: Request): Promise<Map<string, string>> {
  const ct = req.headers.get('content-type') ?? ''
  const m = new Map<string, string>()
  if (ct.includes('application/json')) {
    const j = await req.json().catch(() => ({}))
    for (const [k, v] of Object.entries(j ?? {})) m.set(k, String(v))
    return m
  }
  const f = await req.formData().catch(() => null)
  if (f) for (const [k, v] of f.entries()) m.set(k, v.toString())
  return m
}

async function token(req: Request): Promise<Response> {
  const form = await readForm(req)
  const grant = form.get('grant_type')
  const db = admin()
  if (grant === 'authorization_code') return codeGrant(db, form)
  if (grant === 'refresh_token') return refreshGrant(db, form)
  return json({ error: 'unsupported_grant_type' }, 400, NO_STORE)
}

async function mintAccessToken(db: DB, ownerId: string, clientId: string | null): Promise<Response> {
  // mcp_tokens.token is a uuid — reusing it keeps the resource server's auth path
  // (`.eq('token', token)`) unchanged. 122 bits is ample for a bearer token.
  const accessToken = crypto.randomUUID()
  const refreshToken = randomToken(32)
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000).toISOString()
  const { error } = await db.from('mcp_tokens').insert({
    owner_id: ownerId,
    token: accessToken,
    name: 'Claude (OAuth)',
    client_id: clientId,
    refresh_token: refreshToken,
    expires_at: expiresAt,
  })
  if (error) return json({ error: 'server_error' }, 500, NO_STORE)
  return json(
    { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SEC, refresh_token: refreshToken, scope: 'mcp' },
    200,
    NO_STORE,
  )
}

async function codeGrant(db: DB, form: Map<string, string>): Promise<Response> {
  const code = form.get('code') ?? ''
  const verifier = form.get('code_verifier') ?? ''
  const clientId = form.get('client_id') ?? ''
  const redirectUri = form.get('redirect_uri') ?? ''
  if (!code || !verifier) return json({ error: 'invalid_request' }, 400, NO_STORE)

  // Atomically claim the code (single-use): flip used=false→true and read the row.
  const { data: rows } = await db
    .from('oauth_authorization_codes')
    .update({ used: true })
    .eq('code', code)
    .eq('used', false)
    .select()
    .limit(1)
  const row = rows?.[0] as
    | { owner_id: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: string }
    | undefined
  if (!row) return json({ error: 'invalid_grant', error_description: 'code invalid or already used' }, 400, NO_STORE)
  if (Date.parse(row.expires_at) <= Date.now()) return json({ error: 'invalid_grant', error_description: 'code expired' }, 400, NO_STORE)
  if (clientId && row.client_id !== clientId) return json({ error: 'invalid_grant' }, 400, NO_STORE)
  if (redirectUri && row.redirect_uri !== redirectUri) return json({ error: 'invalid_grant' }, 400, NO_STORE)
  if (!(await verifyPkceS256(verifier, row.code_challenge))) {
    return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400, NO_STORE)
  }
  return mintAccessToken(db, row.owner_id, row.client_id)
}

async function refreshGrant(db: DB, form: Map<string, string>): Promise<Response> {
  const refreshToken = form.get('refresh_token') ?? ''
  if (!refreshToken) return json({ error: 'invalid_request' }, 400, NO_STORE)
  const { data: rows } = await db.from('mcp_tokens').select('id, owner_id, client_id').eq('refresh_token', refreshToken).limit(1)
  const row = rows?.[0] as { id: string; owner_id: string; client_id: string | null } | undefined
  if (!row) return json({ error: 'invalid_grant' }, 400, NO_STORE)
  // Rotate in place: a new access + refresh token on the same row revokes the old ones.
  const newAccess = crypto.randomUUID()
  const newRefresh = randomToken(32)
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000).toISOString()
  const { error } = await db
    .from('mcp_tokens')
    .update({ token: newAccess, refresh_token: newRefresh, expires_at: expiresAt, last_used_at: new Date().toISOString() })
    .eq('id', row.id)
  if (error) return json({ error: 'server_error' }, 500, NO_STORE)
  return json(
    { access_token: newAccess, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SEC, refresh_token: newRefresh, scope: 'mcp' },
    200,
    NO_STORE,
  )
}
