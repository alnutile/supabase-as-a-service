// Supabase Edge Function: `mcp-admin` (verify_jwt = true, admin-only).
// Validates the configured external MCP server and refreshes the cached toolset
// so Settings can show "connected — N tools" immediately after an admin saves
// the endpoint + token (otherwise discovery happens lazily on the first agent
// run). The bearer token is read server-side from Vault; it never reaches the
// browser. Mirrors `email-test` in spirit.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { listRemoteTools } from '../_shared/mcp.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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

  // Non-secret config (endpoint URL) + the Vault token, both server-side.
  const { data: integ } = await db.from('integrations').select('config').eq('kind', 'mcp').maybeSingle()
  const mcpUrl = (integ?.config as { url?: string } | null)?.url
  if (!mcpUrl) return json({ ok: false, message: 'No MCP server is configured yet.' }, 400)
  const { data: token } = await db.rpc('read_mcp_secret')
  if (!token || typeof token !== 'string') {
    return json({ ok: false, message: 'The MCP token could not be read. Re-save it in Settings.' }, 400)
  }

  try {
    const tools = await listRemoteTools({ url: mcpUrl, token })
    // Cache onto the single kind='mcp' tools handle for the agent loops.
    const { data: row } = await db.from('tools').select('id, config').eq('kind', 'mcp').maybeSingle()
    if (row) {
      await db
        .from('tools')
        .update({ config: { ...(row.config ?? {}), url: mcpUrl, tools, cached_at: new Date().toISOString() } })
        .eq('id', row.id)
    }
    return json({ ok: true, count: tools.length, tools: tools.map((t) => t.name) })
  } catch (err) {
    return json({ ok: false, message: err instanceof Error ? err.message : 'Connection failed' }, 502)
  }
})
