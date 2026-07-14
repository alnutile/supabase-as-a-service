# MCP connector OAuth (paste-URL-and-approve)

Lets a workspace member connect Claude to their intranet by pasting the MCP URL into
**Claude → Settings → Connectors → Add custom connector** and clicking **Approve** — no
static token to copy. The static `mcp_tokens` path (Settings → Connect Claude, `claude mcp
add --header …`) keeps working unchanged; this only adds the OAuth option on top.

## What the user does
1. In Claude, **Add custom connector**.
2. **Remote MCP server URL** = their workspace MCP endpoint, e.g.
   `https://<project-ref>.supabase.co/functions/v1/mcp` (or a custom functions domain).
   Leave OAuth Client ID/Secret **empty** — Claude auto-discovers and self-registers.
3. Claude opens a login page served by the workspace; they sign in with their **workspace
   email + password** and approve. Done — tools appear, every call runs as that user.

## How it works
Two edge functions, both `verify_jwt=false`:

- **`mcp`** (resource server) — unchanged except it now (a) serves
  `GET …/mcp/.well-known/oauth-protected-resource`, (b) returns `401` with a
  `WWW-Authenticate: Bearer resource_metadata="…"` header when unauthenticated, and (c)
  rejects **expired** tokens. It still resolves `Authorization: Bearer <token>` →
  `mcp_tokens.owner_id`.
- **`mcp-oauth`** (authorization server, new) — the OAuth 2.1 + PKCE flow:
  `/.well-known/oauth-authorization-server` (metadata) · `/register` (Dynamic Client
  Registration, RFC 7591) · `/authorize` (GET renders login, POST processes it) · `/token`
  (authorization_code + refresh_token grants).

Key properties:
- **Login delegates to the tenant's own Supabase Auth** (GoTrue password grant). The OAuth
  server never becomes the identity provider and never stores the credential.
- The access token is **minted as an `mcp_tokens` row** (`token` = uuid, `expires_at` = 30d,
  `refresh_token`, issuing `client_id`), so the resource server's existing auth path is reused.
- **Every endpoint URL is derived from the request host** (`functionBaseUrl`), so it works on
  `*.supabase.co`, a custom domain, or the future hosted proxy with nothing hardcoded.
- **PKCE S256 required** (never `plain`); auth codes are single-use with a 5-minute TTL and
  bound to `redirect_uri` + challenge; `redirect_uri` is exact-matched against the
  DCR-registered set; refresh rotates the token in place.

Backing tables: migration `0070_mcp_oauth.sql` (`oauth_clients`,
`oauth_authorization_codes`, + nullable `expires_at`/`refresh_token`/`client_id` on
`mcp_tokens`). Pure logic in `supabase/functions/_shared/oauth.ts`, unit-tested in
`tests/oauth_test.ts`.

## `*.supabase.co` discovery caveat
RFC 8414/9728 also define **root** well-known paths (`https://host/.well-known/…`). On a
shared `*.supabase.co` host we can't serve the domain root, so discovery relies on the
`WWW-Authenticate` `resource_metadata` pointer + the function-suffixed well-known path
(which the MCP client SDK falls back to). A **custom functions domain** (or the hosted
`connection.supanet.io` proxy) can serve the root paths for the strictest clients.

## Manual verification (until tested against a live Claude connector)
Against a deployed project (`BASE=https://<ref>.supabase.co/functions/v1`):

```bash
# 1. Discovery
curl -s "$BASE/mcp-oauth/.well-known/oauth-authorization-server" | jq
curl -s "$BASE/mcp/.well-known/oauth-protected-resource" | jq
curl -s -i -X POST "$BASE/mcp" -d '{}' | grep -i www-authenticate   # 401 + pointer

# 2. Dynamic Client Registration
curl -s -X POST "$BASE/mcp-oauth/register" \
  -H 'content-type: application/json' \
  -d '{"client_name":"test","redirect_uris":["http://localhost:9000/cb"]}' | jq

# 3. Open in a browser (PKCE: pick a 43+ char verifier, S256 → challenge):
#    $BASE/mcp-oauth/authorize?response_type=code&client_id=<id>&redirect_uri=http://localhost:9000/cb&code_challenge=<challenge>&code_challenge_method=S256&state=xyz
#    → log in → redirects to the redirect_uri with ?code=…

# 4. Exchange the code
curl -s -X POST "$BASE/mcp-oauth/token" \
  -d grant_type=authorization_code -d code=<code> -d code_verifier=<verifier> \
  -d client_id=<id> -d redirect_uri=http://localhost:9000/cb | jq

# 5. Use the access_token on a real MCP call
curl -s -X POST "$BASE/mcp" -H "authorization: Bearer <access_token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
```

## Follow-ups (not built)
- A consent screen (v1 treats successful login as consent).
- A "Connections" admin view over `oauth_clients` + issued tokens (revoke).
- The hosted `connection.supanet.io` proxy that fronts many tenants behind one reviewed
  connector — this OAuth server is its per-tenant building block.
