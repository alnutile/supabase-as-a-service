// Supabase Edge Function: `mcp-connect` (verify_jwt = true, admin-only).
// Starts the OUTBOUND MCP OAuth flow — the workspace connecting (as an MCP client)
// to an OAuth-protected MCP server. It discovers the server's authorization
// endpoints (RFC 9728 / 8414), dynamically registers a public PKCE client
// (RFC 7591) when the server supports it, stores the pending state + PKCE verifier,
// and returns the /authorize URL for the browser to redirect to. The browser comes
// back to `mcp-oauth-callback`, which exchanges the code for tokens.
//
// Two actions:
//   { action:'create', label, url, manual?, return_to } → create the mcp_servers
//        row (+ its kind='mcp' tools handle) as auth_type='oauth', then start.
//   { action:'start', server_id, manual?, return_to }    → (re)connect an existing
//        OAuth server.
// `manual` lets an admin bypass discovery/DCR for servers that don't support them:
//   { authorization_endpoint, token_endpoint, client_id, client_secret?, scope? }.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { functionBaseUrl } from '../_shared/oauth.ts'
import { mcpPrefix } from '../_shared/mcp.ts'
import { buildAuthorizeUrl, discoverAuthServer, dynamicRegister, newPkce } from '../_shared/mcp_oauth.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes to complete the login+consent

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function userIdFromAuth(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof claims.sub === 'string' ? claims.sub : null
  } catch {
    return null
  }
}

interface Manual {
  authorization_endpoint?: string
  token_endpoint?: string
  client_id?: string
  client_secret?: string
  scope?: string
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, message: 'Use POST' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return json({ ok: false, message: 'Server not configured' }, 500)
  const db = createClient(url, key)

  const userId = userIdFromAuth(req)
  if (!userId) return json({ ok: false, message: 'Unauthorized' }, 401)
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  if (!profile?.is_admin) return json({ ok: false, message: 'Admin only' }, 403)

  let body: {
    action?: string
    server_id?: string
    label?: string
    url?: string
    manual?: Manual
    return_to?: string
  }
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, message: 'Invalid body' }, 400)
  }

  const action = body.action === 'create' ? 'create' : 'start'
  let serverId = body.server_id
  let mcpUrl = ''

  if (action === 'create') {
    const label = (body.label ?? '').trim() || 'mcp'
    mcpUrl = (body.url ?? '').trim()
    if (!mcpUrl) return json({ ok: false, message: 'An MCP endpoint URL is required.' }, 400)
    const name = mcpPrefix(label)
    // Create the server row, then its kind='mcp' handle (mirrors set_mcp_server's
    // create branch, minus the token — OAuth has no token until it connects).
    const { data: srv, error: srvErr } = await db
      .from('mcp_servers')
      .insert({ label, url: mcpUrl, auth_type: 'oauth', scope: 'workspace', oauth: { status: 'disconnected' } })
      .select('id')
      .single()
    if (srvErr || !srv) return json({ ok: false, message: srvErr?.message ?? 'Could not create server' }, 500)
    serverId = srv.id as string
    const { data: tool } = await db
      .from('tools')
      .insert({
        name,
        description: `External MCP server "${label}" (OAuth) — exposes its remote tools to agents.`,
        kind: 'mcp',
        config: { url: mcpUrl, server_id: serverId },
        is_active: true,
        is_builtin: false,
        created_by: userId,
      })
      .select('id')
      .single()
    if (tool?.id) await db.from('mcp_servers').update({ tool_id: tool.id }).eq('id', serverId)
  } else {
    if (!serverId) return json({ ok: false, message: 'A server_id is required.' }, 400)
    const { data: srv } = await db.from('mcp_servers').select('url').eq('id', serverId).maybeSingle()
    if (!srv?.url) return json({ ok: false, message: 'That MCP server was not found.' }, 404)
    mcpUrl = srv.url as string
  }

  // Resolve the OAuth endpoints + client id, via manual override or discovery+DCR.
  const manual = body.manual ?? {}
  const redirectUri = functionBaseUrl(req.url, 'mcp-oauth-callback')
  let authorizationEndpoint = (manual.authorization_endpoint ?? '').trim()
  let tokenEndpoint = (manual.token_endpoint ?? '').trim()
  let registrationEndpoint = ''
  let clientId = (manual.client_id ?? '').trim()
  let clientSecret = (manual.client_secret ?? '').trim()
  const scope = (manual.scope ?? '').trim() || undefined

  if (!authorizationEndpoint || !tokenEndpoint) {
    const discovered = await discoverAuthServer(mcpUrl)
    if (!discovered) {
      return json(
        {
          ok: false,
          needs_manual: true,
          message:
            'Could not auto-discover this server\'s OAuth endpoints. Enter the authorization and token endpoints (and a client ID) manually.',
        },
        422,
      )
    }
    authorizationEndpoint = authorizationEndpoint || discovered.authorization_endpoint
    tokenEndpoint = tokenEndpoint || discovered.token_endpoint
    registrationEndpoint = discovered.registration_endpoint ?? ''
  }

  if (!clientId) {
    if (!registrationEndpoint) {
      return json(
        {
          ok: false,
          needs_manual: true,
          message:
            'This server does not support automatic client registration. Register a client with it and enter the client ID (and secret, if any) manually.',
        },
        422,
      )
    }
    const reg = await dynamicRegister(registrationEndpoint, redirectUri, 'Supabase intranet')
    if (!reg) return json({ ok: false, message: 'Client registration with the MCP server failed.' }, 502)
    clientId = reg.client_id
    if (reg.client_secret) clientSecret = reg.client_secret
  }

  const resource = mcpUrl // RFC 8707 resource indicator = the MCP endpoint
  const { verifier, challenge, state } = await newPkce()

  // Persist the resolved config (endpoints/client_id/redirect/scope/resource) +
  // the client secret (into Vault), then the pending state for the callback.
  const { error: cfgErr } = await db.rpc('save_mcp_oauth_config', {
    p_server_id: serverId,
    p_oauth: {
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      registration_endpoint: registrationEndpoint || null,
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scope ?? null,
      resource,
      status: 'connecting',
    },
    p_client_secret: clientSecret || '',
  })
  if (cfgErr) return json({ ok: false, message: cfgErr.message }, 500)

  const { error: stErr } = await db.from('mcp_oauth_states').insert({
    state,
    server_id: serverId,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    client_id: clientId,
    scope: scope ?? null,
    resource,
    return_to: (body.return_to ?? '').trim() || null,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  })
  if (stErr) return json({ ok: false, message: stErr.message }, 500)

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint,
    clientId,
    redirectUri,
    codeChallenge: challenge,
    state,
    scope,
    resource,
  })
  return json({ ok: true, authorize_url: authorizeUrl, server_id: serverId })
})
