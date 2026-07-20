// Control-plane edge function: `status` (PUBLIC — verify_jwt=false).
// GET ?token=<status_token> → the tenant's provisioning state for the waiting
// page: overall status, the step checklist (ticking live as the worker
// persists after every step), and the app URL once ready. Lookup is ONLY by
// the opaque status_token, so there is nothing to enumerate.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

// Human labels for the engine's step names — keep in sync with engine/steps.ts.
const STEP_LABELS: Record<string, string> = {
  createProject: 'Creating your private database',
  waitForHealthy: 'Waking it up',
  fetchApiKeys: 'Issuing keys',
  applyMigrations: 'Building your workspace schema',
  deployFunctions: 'Installing the AI engine',
  mintOpenRouterKey: 'Connecting AI models',
  setSecrets: 'Locking in secrets',
  createRailwayService: 'Deploying your app',
  attachTenantDomain: 'Claiming your address',
  wireDns: 'Pointing DNS',
  configureAuth: 'Configuring sign-in',
  verify: 'Checking everything works',
  verifyCustomDomain: 'Securing your domain (TLS)',
}
const STEP_ORDER = Object.keys(STEP_LABELS)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const token = new URL(req.url).searchParams.get('token') ?? ''
  if (!/^[0-9a-f-]{36}$/.test(token)) return json({ error: 'bad token' }, 400)

  const { data: tenant } = await db
    .from('tenants')
    .select('id, slug, name, status, app_url, created_at')
    .eq('status_token', token)
    .maybeSingle()
  if (!tenant) return json({ error: 'not found' }, 404)

  const { data: job } = await db
    .from('provisioning_jobs')
    .select('status, steps, error, updated_at')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const done = new Map<string, { status: string; error?: string }>()
  for (const s of ((job?.steps ?? []) as Array<{ name: string; status: string; error?: string }>)) {
    done.set(s.name, { status: s.status, error: s.error })
  }
  const steps = STEP_ORDER.map((name) => ({
    name,
    label: STEP_LABELS[name],
    status: done.get(name)?.status ?? 'pending',
  }))

  return json({
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    app_url: tenant.app_url,
    job_status: job?.status ?? null,
    job_error: job?.error ?? null,
    steps,
  })
})
