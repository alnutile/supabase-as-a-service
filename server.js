// Production server for Railway. Replaces the plain `serve -s dist` static host
// with a small Express app that ALSO fronts the MCP connector + its OAuth server
// at the app's OWN domain.
//
// Why: Claude's "Add custom connector" OAuth discovery fetches
// /.well-known/oauth-authorization-server at the DOMAIN ROOT. On *.supabase.co
// that root is owned by Supabase's gateway (returns 401), so discovery fails and
// registration never completes. Our app domain is a host WE control, so we serve
// the discovery documents here and reverse-proxy the actual OAuth + MCP work to
// the existing Supabase edge functions — which already implement the whole flow.
// Everything else falls through to the SPA.
//
// Discovery is served PER-REQUEST from the incoming Host, so this needs no origin
// config and works on any domain (a tenant's custom domain, *.up.railway.app, or
// localhost) — the same "nothing hardcoded" property the edge functions have.
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8080
const DIST = path.join(__dirname, 'dist')

// Base URL of the Supabase edge functions (…/functions/v1) to proxy to.
const FN = (
  process.env.SUPABASE_FUNCTIONS_URL ||
  (process.env.VITE_SUPABASE_URL ? `${process.env.VITE_SUPABASE_URL}/functions/v1` : '')
).replace(/\/+$/, '')

if (!FN) {
  console.error('[server] SUPABASE_FUNCTIONS_URL (or VITE_SUPABASE_URL) is required')
  process.exit(1)
}

// The public origin the request arrived on. Railway terminates TLS and sets
// x-forwarded-proto/-host; fall back to Host + https.
function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim()
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim()
  return `${proto}://${host}`
}

const app = express()
app.disable('x-powered-by')

// 1) OAuth discovery at the root — the part *.supabase.co cannot serve. We advertise
//    APP-DOMAIN endpoints; the real work is proxied to the edge functions below.
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const o = originOf(req)
  res.json({
    issuer: o,
    authorization_endpoint: `${o}/mcp-oauth/authorize`,
    token_endpoint: `${o}/mcp-oauth/token`,
    registration_endpoint: `${o}/mcp-oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  })
})
// Protected-resource metadata (RFC 9728). Serve both the root and the path-inserted
// form (`…/mcp`) so whichever variant the client requests resolves.
function protectedResource(req, res) {
  const o = originOf(req)
  res.json({ resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ['header'] })
}
app.get('/.well-known/oauth-protected-resource', protectedResource)
app.get('/.well-known/oauth-protected-resource/mcp', protectedResource)

// 2) Reverse-proxy the OAuth action endpoints + the MCP endpoint to the edge functions.
// The edge's login/consent pages are text/html, but Supabase rewrites text/html →
// text/plain (+ a sandbox CSP) on *.supabase.co function URLs (anti-phishing). Since we
// re-serve them from a domain we control, restore text/html and drop the sandbox CSP so
// the page renders. JSON responses are unaffected.
const restoreHtml = (proxyRes) => {
  const ct = String(proxyRes.headers['content-type'] || '')
  if (ct.startsWith('text/plain')) {
    proxyRes.headers['content-type'] = 'text/html; charset=utf-8'
    delete proxyRes.headers['content-security-policy']
    delete proxyRes.headers['x-content-type-options']
  }
}
// On the MCP resource endpoint, point the 401 challenge at OUR discovery doc.
const rewriteWwwAuth = (proxyRes, req) => {
  if (proxyRes.headers['www-authenticate']) {
    proxyRes.headers['www-authenticate'] =
      `Bearer resource_metadata="${originOf(req)}/.well-known/oauth-protected-resource/mcp"`
  }
}
app.use(
  '/mcp-oauth',
  createProxyMiddleware({
    target: `${FN}/mcp-oauth`,
    changeOrigin: true,
    pathRewrite: { '^/mcp-oauth': '' },
    on: { proxyRes: restoreHtml },
  }),
)
app.use(
  '/mcp',
  createProxyMiddleware({
    target: `${FN}/mcp`,
    changeOrigin: true,
    pathRewrite: { '^/mcp': '' },
    on: { proxyRes: rewriteWwwAuth },
  }),
)

// 3) Static SPA + history fallback (what `serve -s dist` used to do).
app.use(express.static(DIST, { index: false }))
app.get('*', (_req, res) => {
  const index = path.join(DIST, 'index.html')
  if (existsSync(index)) return res.sendFile(index)
  res.status(503).send('Frontend build not found')
})

app.listen(PORT, '0.0.0.0', () => console.log(`[server] listening on ${PORT} · functions=${FN}`))
