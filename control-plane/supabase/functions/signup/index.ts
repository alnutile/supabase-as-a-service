// Control-plane edge function: `signup` (PUBLIC — verify_jwt=false).
// POST { slug, name, email } → creates the tenant + queues a provisioning job
// and returns { status_token } for the waiting page to poll `status` with.
//
// Payment: when PAYMENT_REQUIRED=true (Stripe keys wired, slice 3), the tenant
// is created as pending_payment and the response carries a checkout_url instead
// of queueing — the stripe-webhook flips it to queued. Until then signups queue
// immediately (private beta mode).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/
// Subdomains we will never hand to a tenant.
const RESERVED = new Set([
  'www', 'api', 'app', 'mail', 'smtp', 'admin', 'status', 'docs', 'blog',
  'help', 'support', 'billing', 'dashboard', 'control', 'cdn', 'static',
])

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  let body: { slug?: string; name?: string; email?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const slug = (body.slug ?? '').trim().toLowerCase()
  const name = (body.name ?? '').trim().slice(0, 80)
  const email = (body.email ?? '').trim().toLowerCase()

  if (!SLUG_RE.test(slug)) return json({ error: 'Workspace URL must be 2–31 lowercase letters, digits or hyphens.' }, 400)
  if (RESERVED.has(slug)) return json({ error: 'That workspace URL is reserved — pick another.' }, 400)
  if (!name) return json({ error: 'Workspace name is required.' }, 400)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid email is required.' }, 400)

  const paymentRequired = (Deno.env.get('PAYMENT_REQUIRED') ?? 'false') === 'true'

  const { data: tenant, error } = await db
    .from('tenants')
    .insert({
      slug,
      name,
      admin_email: email,
      status: paymentRequired ? 'pending_payment' : 'provisioning',
    })
    .select('id, status_token')
    .single()
  if (error) {
    if (error.code === '23505') return json({ error: 'That workspace URL is taken — pick another.' }, 409)
    console.error('tenant insert failed', error)
    return json({ error: 'Could not create the workspace. Try again.' }, 500)
  }

  await db.from('cp_events').insert({ tenant_id: tenant.id, type: 'signup', detail: { slug, email } })

  if (paymentRequired) {
    // Stripe Checkout: provisioning starts only when the stripe-webhook sees
    // checkout.session.completed. success_url carries the status token so the
    // waiting page resumes after redirect.
    const site = Deno.env.get('SIGNUP_SITE_URL') ?? 'https://start.supanet.io'
    const params = new URLSearchParams()
    params.set('mode', 'subscription')
    params.set('line_items[0][price]', Deno.env.get('STRIPE_PRICE_ID')!)
    params.set('line_items[0][quantity]', '1')
    params.set('customer_email', email)
    params.set('metadata[tenant_id]', tenant.id)
    params.set('subscription_data[metadata][tenant_id]', tenant.id)
    params.set('success_url', `${site}/?token=${tenant.status_token}`)
    params.set('cancel_url', `${site}/?canceled=1`)
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })
    const session = await res.json()
    if (!res.ok) {
      console.error('checkout session failed', session?.error?.message)
      return json({ error: 'Could not start checkout. Try again.' }, 500)
    }
    return json({ status_token: tenant.status_token, next: 'payment', checkout_url: session.url })
  }

  const { error: jobErr } = await db.from('provisioning_jobs').insert({ tenant_id: tenant.id })
  if (jobErr) {
    console.error('job insert failed', jobErr)
    return json({ error: 'Could not queue provisioning. Contact support.' }, 500)
  }
  return json({ status_token: tenant.status_token, next: 'provisioning' })
})
