// Supabase Edge Function: `openrouter-balance` (verify_jwt=true).
// Returns the OpenRouter account balance for the workspace key — used by the
// /usage page. The OPENROUTER_API_KEY is server-only, so the browser can't call
// OpenRouter directly; this admin-gated function proxies GET /api/v1/key.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { orApiKey } from '../_shared/openrouter.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
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

  const key = orApiKey()
  if (!key) return json({ error: 'OPENROUTER_API_KEY is not configured' }, 500)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const userId = userIdFromAuth(req)
  if (!supabaseUrl || !serviceKey || !userId) return json({ error: 'Unauthorized' }, 401)

  // Admin-only — balance is workspace-wide.
  const db = createClient(supabaseUrl, serviceKey)
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  if (!profile?.is_admin) return json({ error: 'Admin only' }, 403)

  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) return json({ error: `OpenRouter returned ${res.status}` }, 502)
    const body = await res.json()
    const d = body?.data ?? {}
    return json({
      label: d.label ?? null,
      usage: typeof d.usage === 'number' ? d.usage : null,
      limit: typeof d.limit === 'number' ? d.limit : null,
      limit_remaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null,
      is_free_tier: Boolean(d.is_free_tier),
    })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'request failed' }, 502)
  }
})
