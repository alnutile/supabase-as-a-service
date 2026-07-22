// Control-plane edge function: `admin` (verify_jwt=true + an ADMIN_EMAILS
// allowlist checked in code). Powers start.supanet.io/admin.html:
//   POST {action:'list'}                          → all tenants + latest job
//   POST {action:'teardown', tenant_id, confirm_slug} → queue a teardown job
//   POST {action:'retry', tenant_id}              → requeue a failed job
// Teardown queues a `kind:'teardown'` job for the worker (which holds the infra
// credentials); this function never touches Railway/Cloudflare/etc. itself.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

function isAdmin(email: string | undefined): boolean {
  const allow = (Deno.env.get('ADMIN_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return Boolean(email && allow.includes(email.toLowerCase()))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: userData } = await db.auth.getUser(token)
  const email = userData?.user?.email
  if (!isAdmin(email)) return json({ error: 'admins only' }, 403)

  const body = await req.json().catch(() => ({}))

  if (body.action === 'list') {
    const { data: tenants } = await db
      .from('tenants')
      .select('id, slug, name, admin_email, status, app_url, project_ref, stripe_subscription_id, created_at')
      .order('created_at', { ascending: false })
    const { data: jobs } = await db
      .from('provisioning_jobs')
      .select('tenant_id, kind, status, error, updated_at')
      .order('created_at', { ascending: false })
    const latest = new Map<string, unknown>()
    for (const j of jobs ?? []) if (!latest.has(j.tenant_id)) latest.set(j.tenant_id, j)
    return json({ tenants: (tenants ?? []).map((t) => ({ ...t, job: latest.get(t.id) ?? null })) })
  }

  if (body.action === 'teardown') {
    const { data: tenant } = await db
      .from('tenants')
      .select('id, slug, status')
      .eq('id', body.tenant_id ?? '')
      .maybeSingle()
    if (!tenant) return json({ error: 'unknown tenant' }, 404)
    // Typed-slug confirmation — the one-click is on the page; the API demands proof.
    if (body.confirm_slug !== tenant.slug) return json({ error: 'confirm_slug does not match' }, 400)
    if (tenant.status === 'deleted') return json({ error: 'already deleted' }, 400)

    // Supersede any existing job rows so the claim RPC picks up the teardown.
    await db.from('provisioning_jobs').delete().eq('tenant_id', tenant.id)
    await db.from('provisioning_jobs').insert({ tenant_id: tenant.id, kind: 'teardown' })
    await db.from('tenants').update({ status: 'canceled' }).eq('id', tenant.id)
    await db.from('cp_events').insert({ tenant_id: tenant.id, type: 'teardown.requested', detail: { by: email } })
    return json({ ok: true })
  }

  if (body.action === 'retry') {
    const { error } = await db
      .from('provisioning_jobs')
      .update({ status: 'queued', error: null, claimed_at: null, lease_expires_at: null })
      .eq('tenant_id', body.tenant_id ?? '')
      .eq('status', 'error')
    if (error) return json({ error: error.message }, 500)
    return json({ ok: true })
  }

  return json({ error: 'unknown action' }, 400)
})
