// Control-plane edge function: `account` (verify_jwt=true — requires a signed-in
// control-plane user, i.e. a customer who completed the magic link).
// POST { tenant_id, action: 'billing_portal' } → a Stripe customer-portal URL
// for that tenant, only if the caller's email matches the tenant's admin_email.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  // Resolve the caller from their JWT — never trust the payload for identity.
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: userData, error: userErr } = await db.auth.getUser(token)
  const email = userData?.user?.email?.toLowerCase()
  if (userErr || !email) return json({ error: 'not signed in' }, 401)

  const body = await req.json().catch(() => ({}))
  const { data: tenant } = await db
    .from('tenants')
    .select('id, slug, admin_email, stripe_customer_id')
    .eq('id', body.tenant_id ?? '')
    .maybeSingle()
  if (!tenant || tenant.admin_email.toLowerCase() !== email) return json({ error: 'not your workspace' }, 403)

  if (body.action === 'billing_portal') {
    if (!tenant.stripe_customer_id) {
      return json({ error: 'No billing on file for this workspace — contact support.' }, 400)
    }
    const params = new URLSearchParams()
    params.set('customer', tenant.stripe_customer_id)
    params.set('return_url', Deno.env.get('SIGNUP_SITE_URL') ?? 'https://start.supanet.io/account.html')
    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })
    const session = await res.json()
    if (!res.ok) {
      console.error('portal session failed', session?.error?.message)
      return json({ error: 'Could not open the billing portal. Try again.' }, 500)
    }
    return json({ url: session.url })
  }

  return json({ error: 'unknown action' }, 400)
})
