// Supabase Edge Function: `email-test`
// Admin-only "send a test email" action for Settings → Email. It runs the exact
// same `send_email` builtin the chat/webhook/scheduler loops use (shared
// runBuiltin), so a green result proves the real path works end to end: the
// integrations row is read, the API key is decrypted from Vault, the provider
// is called, and an `email.sent` activity-log row is written. Deployed with
// verify_jwt = true; the body only carries the recipient.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { runBuiltin } from '../_shared/builtins.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function admin() {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  return url && key ? createClient(url, key) : null
}

// Read the user id (sub) from the forwarded access token — verify_jwt has
// already validated it upstream, so we only decode the claim.
function userIdFromAuth(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const json = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json.sub === 'string' ? json.sub : null
  } catch {
    return null
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS })

  const db = admin()
  if (!db) return json({ error: 'Server is not configured.' }, 500)

  const userId = userIdFromAuth(req)
  if (!userId) return json({ error: 'Not authenticated.' }, 401)

  // Email config is admin-managed, so the test send is admin-only too.
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  if (!profile?.is_admin) return json({ error: 'Only admins can send a test email.' }, 403)

  let to = ''
  try {
    const body = await req.json()
    to = String(body?.to ?? '').trim()
  } catch {
    // fall through — empty `to` is handled below
  }
  if (!to) return json({ error: 'A recipient address is required.' }, 400)

  // Same builtin the agent loops use — it enforces the allowlist + rate limit,
  // reads the Vault key, calls the provider, and logs the send.
  const result = await runBuiltin(
    db,
    'send_email',
    { to, subject: 'Test email from your workspace', body: 'This is a test email confirming your workspace email setup is working.' },
    userId,
  )

  // runBuiltin returns "Email sent to …" on success, or a human-readable reason
  // otherwise. Treat anything that isn't the success sentence as a failure.
  const ok = result.startsWith('Email sent')
  return json({ ok, message: result }, ok ? 200 : 400)
})
