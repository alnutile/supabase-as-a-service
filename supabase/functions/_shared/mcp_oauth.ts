// Outbound MCP OAuth *client*: the workspace connecting OUT to an OAuth-protected
// MCP server (Notion, Linear, GitHub, Atlassian, …) via OAuth 2.1 + PKCE +
// Dynamic Client Registration. The mirror of the inbound authorization server in
// supabase/functions/mcp-oauth — here we are the client, not the server.
//
// Split into PURE helpers (URL/metadata/expiry logic, unit-tested in
// tests/mcp_oauth_test.ts) and impure network/DB functions (discovery, DCR, token
// exchange/refresh, ensureAccessToken) used by the mcp-connect / mcp-oauth-callback
// edge functions and by _shared/mcp.ts when it needs a live bearer for a call.
import { pkceChallengeS256, randomToken } from './oauth.ts'

// deno-lint-ignore no-explicit-any
type DB = any

export interface OAuthMeta {
  authorization_endpoint?: string
  token_endpoint?: string
  registration_endpoint?: string
  client_id?: string
  redirect_uri?: string
  scope?: string
  resource?: string
  status?: string
  expires_at?: string
  connected_at?: string
}

interface OAuthReadResult {
  auth_type?: string
  oauth?: OAuthMeta
  access_token?: string | null
  refresh_token?: string | null
  client_secret?: string | null
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
}

// --- Pure helpers (unit-tested) ---------------------------------------------

/** Extract the `resource_metadata="…"` URL from a WWW-Authenticate response
 *  header (RFC 9728 §5.1). Returns null when absent/malformed. */
export function parseResourceMetadataUrl(wwwAuthenticate: string | null | undefined): string | null {
  if (!wwwAuthenticate) return null
  const m = wwwAuthenticate.match(/resource_metadata\s*=\s*"([^"]+)"/i) ||
    wwwAuthenticate.match(/resource_metadata\s*=\s*([^\s,;]+)/i)
  return m ? m[1] : null
}

/** Candidate authorization-server metadata URLs for an issuer (RFC 8414 + OIDC).
 *  RFC 8414 inserts the well-known segment between host and path; we also try the
 *  naive suffix form and the OIDC discovery doc, since servers vary. Deduped,
 *  order = most-correct first. */
export function authServerMetadataUrls(issuer: string): string[] {
  const out: string[] = []
  const push = (u: string) => {
    if (u && !out.includes(u)) out.push(u)
  }
  let u: URL | null = null
  try {
    u = new URL(issuer)
  } catch {
    return out
  }
  const origin = u.origin
  const path = u.pathname.replace(/\/+$/, '') // no trailing slash
  if (path && path !== '') {
    // RFC 8414: https://host/.well-known/oauth-authorization-server/<path>
    push(`${origin}/.well-known/oauth-authorization-server${path}`)
    push(`${origin}/.well-known/openid-configuration${path}`)
  }
  // Suffix form + root (what most servers actually serve)
  push(`${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`)
  push(`${origin}/.well-known/oauth-authorization-server`)
  push(`${origin}/.well-known/openid-configuration`)
  return out
}

/** Protected-resource metadata URL for an MCP endpoint, when the server didn't
 *  hand one back in WWW-Authenticate (RFC 9728 well-known). */
export function protectedResourceMetadataUrl(mcpUrl: string): string | null {
  try {
    const u = new URL(mcpUrl)
    return `${u.origin}/.well-known/oauth-protected-resource`
  } catch {
    return null
  }
}

/** now + expires_in (seconds) as an ISO string. Falls back to a 1-hour default
 *  when the server omits expires_in. */
export function computeExpiresAtIso(expiresInSec: number | undefined, nowMs: number): string {
  const secs = Number.isFinite(expiresInSec) && (expiresInSec as number) > 0 ? (expiresInSec as number) : 3600
  return new Date(nowMs + secs * 1000).toISOString()
}

/** Is the stored access token expired (or within `skewSec` of expiry)? No expiry
 *  recorded → treat as expired so we refresh (fail toward re-auth, not a stale
 *  401). A malformed timestamp is also treated as expired. */
export function isAccessTokenExpired(expiresAtIso: string | null | undefined, nowMs: number, skewSec = 60): boolean {
  if (!expiresAtIso) return true
  const t = Date.parse(expiresAtIso)
  if (Number.isNaN(t)) return true
  return t - skewSec * 1000 <= nowMs
}

/** Build the /authorize redirect URL for the external AS. Includes the RFC 8707
 *  `resource` indicator (the MCP endpoint) that the MCP spec requires. */
export function buildAuthorizeUrl(p: {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  scope?: string
  resource?: string
}): string {
  const u = new URL(p.authorizationEndpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', p.clientId)
  u.searchParams.set('redirect_uri', p.redirectUri)
  u.searchParams.set('code_challenge', p.codeChallenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', p.state)
  if (p.scope) u.searchParams.set('scope', p.scope)
  if (p.resource) u.searchParams.set('resource', p.resource)
  return u.toString()
}

// --- Network / DB (impure) ---------------------------------------------------

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, init)
    if (!r.ok) return null
    return (await r.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Discover an MCP server's authorization endpoints. Probes the endpoint for a
 *  401 + WWW-Authenticate pointer (RFC 9728), falling back to the well-known
 *  protected-resource doc, then reads the authorization-server metadata. Returns
 *  null when nothing resolves (caller then asks for manual config). */
export async function discoverAuthServer(
  mcpUrl: string,
): Promise<{ authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string } | null> {
  // 1. Provoke a 401 to read the resource_metadata pointer.
  let resourceMetaUrl: string | null = null
  try {
    const probe = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    resourceMetaUrl = parseResourceMetadataUrl(probe.headers.get('WWW-Authenticate'))
  } catch {
    // ignore — fall through to well-known probing
  }
  if (!resourceMetaUrl) resourceMetaUrl = protectedResourceMetadataUrl(mcpUrl)

  // 2. resource metadata → authorization server issuer(s)
  const issuers: string[] = []
  if (resourceMetaUrl) {
    const rm = await fetchJson(resourceMetaUrl)
    const servers = rm?.authorization_servers
    if (Array.isArray(servers)) for (const s of servers) if (typeof s === 'string') issuers.push(s)
  }
  // Fallback: treat the MCP origin itself as the issuer.
  try {
    issuers.push(new URL(mcpUrl).origin)
  } catch {
    // ignore
  }

  // 3. For each candidate issuer, read AS metadata.
  for (const issuer of issuers) {
    for (const metaUrl of authServerMetadataUrls(issuer)) {
      const meta = await fetchJson(metaUrl)
      const authz = meta?.authorization_endpoint
      const token = meta?.token_endpoint
      if (typeof authz === 'string' && typeof token === 'string') {
        const reg = meta?.registration_endpoint
        return {
          authorization_endpoint: authz,
          token_endpoint: token,
          registration_endpoint: typeof reg === 'string' ? reg : undefined,
        }
      }
    }
  }
  return null
}

/** Dynamic Client Registration (RFC 7591) as a public PKCE client. Returns the
 *  issued client_id (+ client_secret when the server insists on confidential). */
export async function dynamicRegister(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<{ client_id: string; client_secret?: string } | null> {
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
  const j = await fetchJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const clientId = j?.client_id
  if (typeof clientId !== 'string' || !clientId) return null
  return { client_id: clientId, client_secret: typeof j?.client_secret === 'string' ? j.client_secret : undefined }
}

function tokenForm(fields: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) if (v) p.set(k, v)
  return p.toString()
}

/** Exchange an authorization code for tokens (authorization_code grant). */
export async function exchangeCode(
  tokenEndpoint: string,
  p: { code: string; redirectUri: string; clientId: string; codeVerifier: string; clientSecret?: string; resource?: string },
): Promise<TokenResponse | null> {
  const body = tokenForm({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.codeVerifier,
    client_secret: p.clientSecret,
    resource: p.resource,
  })
  return postToken(tokenEndpoint, body)
}

/** Refresh an access token (refresh_token grant). */
export async function refreshAccess(
  tokenEndpoint: string,
  p: { refreshToken: string; clientId: string; clientSecret?: string; resource?: string },
): Promise<TokenResponse | null> {
  const body = tokenForm({
    grant_type: 'refresh_token',
    refresh_token: p.refreshToken,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    resource: p.resource,
  })
  return postToken(tokenEndpoint, body)
}

async function postToken(tokenEndpoint: string, body: string): Promise<TokenResponse | null> {
  try {
    const r = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    })
    if (!r.ok) return null
    const j = (await r.json()) as Record<string, unknown>
    const access = j?.access_token
    if (typeof access !== 'string' || !access) return null
    return {
      access_token: access,
      refresh_token: typeof j?.refresh_token === 'string' ? j.refresh_token : undefined,
      expires_in: typeof j?.expires_in === 'number' ? j.expires_in : undefined,
      token_type: typeof j?.token_type === 'string' ? j.token_type : undefined,
      scope: typeof j?.scope === 'string' ? j.scope : undefined,
    }
  } catch {
    return null
  }
}

/** Return a live bearer for a server, handling BOTH auth kinds:
 *  - bearer → the stored static token (read_mcp_secret)
 *  - oauth  → the stored access token, transparently refreshed when expired
 *  Returns null when nothing usable is available. */
export async function ensureAccessToken(db: DB, serverId: string): Promise<string | null> {
  let info: OAuthReadResult | null = null
  try {
    const { data } = await db.rpc('read_mcp_oauth', { p_server_id: serverId })
    info = (data ?? null) as OAuthReadResult | null
  } catch {
    info = null
  }

  // Bearer servers (and anything the OAuth reader couldn't classify) use the
  // legacy static-token path unchanged.
  if (!info || info.auth_type !== 'oauth') {
    try {
      const { data } = await db.rpc('read_mcp_secret', { p_server_id: serverId })
      return typeof data === 'string' && data ? data : null
    } catch {
      return null
    }
  }

  const meta = info.oauth ?? {}
  const access = info.access_token ?? null
  const nowMs = Date.now()
  if (access && !isAccessTokenExpired(meta.expires_at, nowMs)) return access

  // Expired (or missing) — try a refresh.
  if (info.refresh_token && meta.token_endpoint && meta.client_id) {
    const tok = await refreshAccess(meta.token_endpoint, {
      refreshToken: info.refresh_token,
      clientId: meta.client_id,
      clientSecret: info.client_secret ?? undefined,
      resource: meta.resource,
    })
    if (tok) {
      const expiresAt = computeExpiresAtIso(tok.expires_in, Date.now())
      try {
        await db.rpc('save_mcp_oauth_tokens', {
          p_server_id: serverId,
          p_access: tok.access_token,
          p_refresh: tok.refresh_token ?? '', // '' = keep the existing refresh token
          p_expires_at: expiresAt,
        })
      } catch {
        // best-effort persist; still return the fresh token for this call
      }
      return tok.access_token
    }
  }
  // No refresh possible — hand back whatever we have (may 401, prompting reconnect).
  return access
}

/** Generate a PKCE verifier + S256 challenge + opaque state for a new /authorize
 *  redirect. verifier is 43 chars (RFC 7636 minimum). */
export async function newPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = randomToken(32)
  const challenge = await pkceChallengeS256(verifier)
  const state = randomToken(24)
  return { verifier, challenge, state }
}
