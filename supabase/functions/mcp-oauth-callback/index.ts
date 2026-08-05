// Supabase Edge Function: `mcp-oauth-callback` (PUBLIC — verify_jwt = false).
// The redirect target of the OUTBOUND MCP OAuth flow (started by `mcp-connect`).
// The external authorization server redirects the admin's browser here with
// `?code=&state=`; we look up the pending state, exchange the code for tokens at
// the server's token endpoint (with the PKCE verifier), store the access + refresh
// tokens in Vault, mark the server connected, and best-effort discover its tools.
// Must be public: the redirect arrives with no Supabase session.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { renderErrorPage } from '../_shared/oauth.ts'
import { computeExpiresAtIso, exchangeCode } from '../_shared/mcp_oauth.ts'
import { refreshServer } from '../_shared/mcp.ts'

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function successPage(returnTo: string | null): string {
  const link = returnTo && /^https?:\/\//i.test(returnTo)
    ? `<p><a href="${returnTo.replace(/"/g, '&quot;')}">Return to Settings</a></p>`
    : '<p>You can close this tab and return to Settings.</p>'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Connected</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0b0f;color:#e7e7ea;padding:24px}
.card{max-width:420px;background:#16161c;border:1px solid #26262e;border-radius:14px;padding:28px;text-align:center}
h1{font-size:17px;margin:0 0 8px}p{margin:8px 0 0;color:#a0a0aa;font-size:14px}a{color:#8b7dff}</style></head>
<body><div class="card"><h1>MCP server connected ✓</h1>${link}</div></body></html>`
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const err = url.searchParams.get('error')
  const errDesc = url.searchParams.get('error_description')
  const code = url.searchParams.get('code') ?? ''
  const state = url.searchParams.get('state') ?? ''

  if (err) {
    return html(renderErrorPage('Authorization failed', errDesc || err), 400)
  }
  if (!code || !state) {
    return html(renderErrorPage('Invalid callback', 'The authorization response was missing a code or state.'), 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !key) return html(renderErrorPage('Server error', 'The server is not configured.'), 500)
  const db = createClient(supabaseUrl, key)

  // Claim the pending state single-use (delete + read).
  const { data: stateRows } = await db.from('mcp_oauth_states').delete().eq('state', state).select()
  const st = stateRows?.[0] as
    | {
        server_id: string
        code_verifier: string
        redirect_uri: string
        token_endpoint: string
        client_id: string
        resource: string | null
        return_to: string | null
        expires_at: string
      }
    | undefined
  if (!st) return html(renderErrorPage('Expired or unknown request', 'Start the connection again from Settings → External MCP.'), 400)
  if (Date.parse(st.expires_at) <= Date.now()) {
    return html(renderErrorPage('Request expired', 'The authorization took too long. Start again from Settings → External MCP.'), 400)
  }

  // The client secret (if this is a confidential client) lives in Vault.
  let clientSecret: string | undefined
  try {
    const { data } = await db.rpc('read_mcp_oauth', { p_server_id: st.server_id })
    const cs = (data as { client_secret?: string | null } | null)?.client_secret
    if (typeof cs === 'string' && cs) clientSecret = cs
  } catch {
    // no secret — public client
  }

  const tok = await exchangeCode(st.token_endpoint, {
    code,
    redirectUri: st.redirect_uri,
    clientId: st.client_id,
    codeVerifier: st.code_verifier,
    clientSecret,
    resource: st.resource ?? undefined,
  })
  if (!tok) return html(renderErrorPage('Token exchange failed', 'The MCP server rejected the authorization code.'), 502)

  const expiresAt = computeExpiresAtIso(tok.expires_in, Date.now())
  const { error: saveErr } = await db.rpc('save_mcp_oauth_tokens', {
    p_server_id: st.server_id,
    p_access: tok.access_token,
    p_refresh: tok.refresh_token ?? '',
    p_expires_at: expiresAt,
  })
  if (saveErr) return html(renderErrorPage('Server error', 'Could not save the connection.'), 500)

  // Best-effort: discover + cache the toolset so Settings shows tools immediately.
  try {
    const { data: srv } = await db.from('mcp_servers').select('url').eq('id', st.server_id).maybeSingle()
    if (srv?.url) await refreshServer(db, st.server_id, srv.url as string)
  } catch {
    // tools populate lazily on the first agent run
  }

  return html(successPage(st.return_to))
})
