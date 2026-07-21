// Control-plane edge function: `stripe-webhook` (PUBLIC — verify_jwt=false,
// gated by Stripe's signature, not a token).
//
// The payment wall's back half: provisioning starts ONLY here. Signup creates a
// pending_payment tenant + a Checkout session; when checkout.session.completed
// arrives (signature-verified), we record the customer/subscription and queue
// the provisioning job. Subscription-lifecycle events flip tenant status;
// pausing infra on cancel is lifecycle-tick's job (slice 4).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const SIGNING_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

// Verify Stripe-Signature: HMAC-SHA256 of `${t}.${rawBody}` with the endpoint
// secret, compared against the v1 signatures; reject stale timestamps.
async function verifySignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!header || !SIGNING_SECRET) return false
  const parts = new Map(header.split(',').map((p) => p.split('=') as [string, string]))
  const t = parts.get('t')
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
  const v1s = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3))
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`))
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return v1s.some((sig) => {
    if (sig.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
    return diff === 0
  })
}

async function event(tenantId: string | null, type: string, detail: Record<string, unknown> = {}) {
  await db.from('cp_events').insert({ tenant_id: tenantId, type, detail })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const rawBody = await req.text()
  if (!(await verifySignature(rawBody, req.headers.get('stripe-signature')))) {
    return new Response('bad signature', { status: 401 })
  }

  const evt = JSON.parse(rawBody)
  const obj = evt.data?.object ?? {}

  if (evt.type === 'checkout.session.completed') {
    const tenantId = obj.metadata?.tenant_id
    if (!tenantId) return new Response('no tenant_id metadata', { status: 200 })
    const { data: tenant } = await db.from('tenants').select('id, status').eq('id', tenantId).maybeSingle()
    if (!tenant) return new Response('unknown tenant', { status: 200 })

    await db
      .from('tenants')
      .update({
        stripe_customer_id: obj.customer ?? null,
        stripe_subscription_id: obj.subscription ?? null,
        ...(tenant.status === 'pending_payment' ? { status: 'provisioning' } : {}),
      })
      .eq('id', tenantId)
    await event(tenantId, 'payment.completed', { session: obj.id, subscription: obj.subscription })

    // Queue provisioning exactly once (webhooks retry; re-delivery must be a no-op).
    const { data: existing } = await db.from('provisioning_jobs').select('id').eq('tenant_id', tenantId).limit(1)
    if (!existing?.length) await db.from('provisioning_jobs').insert({ tenant_id: tenantId })
    return new Response('ok')
  }

  if (evt.type === 'customer.subscription.deleted' || evt.type === 'invoice.payment_failed') {
    const customer = obj.customer
    if (customer) {
      const { data: tenant } = await db.from('tenants').select('id').eq('stripe_customer_id', customer).maybeSingle()
      if (tenant) {
        const status = evt.type === 'customer.subscription.deleted' ? 'canceled' : 'past_due'
        await db.from('tenants').update({ status }).eq('id', tenant.id)
        await event(tenant.id, 'subscription.' + status, { stripe_event: evt.id })
      }
    }
    return new Response('ok')
  }

  if (evt.type === 'customer.subscription.updated') {
    const customer = obj.customer
    if (customer && obj.status === 'active') {
      // Recovery: a past_due tenant whose payment fixed itself comes back.
      await db.from('tenants').update({ status: 'active' }).eq('stripe_customer_id', customer).eq('status', 'past_due')
    }
    return new Response('ok')
  }

  return new Response('ignored')
})
