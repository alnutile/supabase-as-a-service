// Supabase Edge Function: `link-meta` (verify_jwt=true).
// Fetches a URL server-side and returns its metadata (title, description,
// og:image, favicon) for the Links area — the browser can't read cross-origin
// pages, so this is the "paste a URL and it fills itself in" backend. Any
// signed-in member may call it; it touches no tables and holds no secrets.
// Screenshot capture is a separate, later pipeline (links.screenshot_path).
import { fetchLinkMetadata } from '../_shared/linkmeta.ts'

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
  if (req.method !== 'POST') return json({ error: 'POST a JSON body: { "url": "https://…" }' }, 405)
  if (!userIdFromAuth(req)) return json({ error: 'Unauthorized' }, 401)

  let url = ''
  try {
    const body = await req.json()
    url = String(body?.url ?? '').trim()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!/^https?:\/\//i.test(url)) return json({ error: 'A full http(s) URL is required' }, 400)

  return json(await fetchLinkMetadata(url))
})
