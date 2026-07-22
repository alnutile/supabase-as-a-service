// Teardown pipeline — the provisioner in reverse. Removes a tenant's entire
// stack: Stripe subscription, OpenRouter key, Railway service, DNS records,
// and the Supabase project. Every step treats "already gone" as success, so a
// partial teardown re-runs clean (same resumability contract as provisioning).

import { requireEnv, env } from './env.ts'
import type { Step } from './types.ts'
import * as sb from './supabaseApi.ts'
import * as railway from './railway.ts'
import * as cf from './cloudflare.ts'
import * as or from './openrouter.ts'

export function buildTeardownSteps(): Step[] {
  const tenantDomain = env('TENANT_DOMAIN') ?? 'supanet.io'

  return [
    {
      name: 'cancelStripeSubscription',
      run: async ({ state, log }) => {
        const subId = state.stripeSubscriptionId as string | undefined
        const key = env('STRIPE_SECRET_KEY')
        if (!subId || !key) {
          log(subId ? 'no Stripe key in env — skipping cancel' : 'no subscription on file')
          return
        }
        const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${key}` },
        })
        if (!res.ok && res.status !== 404) {
          const body = await res.text().catch(() => '')
          // resource_missing = already canceled — fine.
          if (!body.includes('resource_missing')) throw new Error(`Stripe cancel failed (${res.status})`)
        }
        log('subscription canceled')
      },
    },
    {
      name: 'disableOpenRouterKey',
      run: async ({ state, log }) => {
        const hash = state.openrouterKeyHash as string | undefined
        if (!hash) {
          log('no key hash on file')
          return
        }
        try {
          await or.disableKey(requireEnv('OPENROUTER_PROVISIONING_KEY'), hash)
          log('runtime key disabled')
        } catch (err) {
          // A 404 means already gone; anything else should surface.
          if (!/404/.test((err as Error).message)) throw err
        }
      },
    },
    {
      name: 'deleteRailwayService',
      run: async ({ state, log }) => {
        const serviceId = state.railwayServiceId as string | undefined
        if (!serviceId) {
          log('no railway service on file')
          return
        }
        try {
          await railway.deleteService(requireEnv('RAILWAY_TOKEN'), serviceId)
          log('railway service deleted (custom domain goes with it)')
        } catch (err) {
          if (!/not found|does not exist/i.test((err as Error).message)) throw err
        }
      },
    },
    {
      name: 'removeDns',
      run: async ({ spec, log }) => {
        const cfOpts = { token: requireEnv('CLOUDFLARE_API_TOKEN'), zoneId: requireEnv('CLOUDFLARE_ZONE_ID') }
        await cf.deleteRecord({ ...cfOpts, type: 'CNAME', name: `${spec.slug}.${tenantDomain}` })
        await cf.deleteRecord({ ...cfOpts, type: 'TXT', name: `_railway-verify.${spec.slug}.${tenantDomain}` })
        log('DNS records removed')
      },
    },
    {
      name: 'deleteSupabaseProject',
      run: async ({ state, log }) => {
        const ref = state.projectRef as string | undefined
        if (!ref) {
          log('no project ref on file')
          return
        }
        await sb.deleteProject(requireEnv('SUPANET_MGMT_PAT'), ref)
        log(`project ${ref} deleted`)
      },
    },
  ]
}
