// The provisioning pipeline: spec → running tenant. Every step is idempotent —
// re-running a completed step must be safe (the runner also skips recorded
// steps, but idempotency is the real guarantee).

import { randomBytes } from 'node:crypto'
import { requireEnv, env } from './env.ts'
import { waitFor } from './pipeline.ts'
import type { Step } from './types.ts'
import * as sb from './supabaseApi.ts'
import * as railway from './railway.ts'
import * as cf from './cloudflare.ts'
import * as or from './openrouter.ts'
import { loadFunctionBundles, loadMigrations } from './repoAssets.ts'

const CRON_SECRET_BYTES = 24

export function buildSteps(): Step[] {
  const pat = requireEnv('SUPANET_MGMT_PAT')
  const orgId = requireEnv('SUPANET_ORG_ID')
  const region = env('TENANT_REGION') ?? 'us-east-1'
  const tenantDomain = env('TENANT_DOMAIN') ?? 'supanet.io'

  return [
    {
      name: 'createProject',
      run: async ({ spec, log }) => {
        const dbPassword = randomBytes(24).toString('base64url')
        const { ref } = await sb.createProject({
          pat,
          organizationId: orgId,
          name: `supanet-${spec.slug}`,
          region,
          dbPassword,
        })
        log(`project ${ref} created in org ${orgId}`)
        return { projectRef: ref, dbPassword }
      },
    },
    {
      name: 'waitForHealthy',
      run: async ({ state }) => {
        const ref = state.projectRef!
        await waitFor('project ACTIVE_HEALTHY', async () => (await sb.projectStatus(pat, ref)) === 'ACTIVE_HEALTHY', {
          timeoutMs: 10 * 60_000,
        })
      },
    },
    {
      name: 'fetchApiKeys',
      run: async ({ state }) => {
        const keys = await sb.getApiKeys(pat, state.projectRef!)
        return { anonKey: keys.anon, serviceRoleKey: keys.serviceRole }
      },
    },
    {
      name: 'applyMigrations',
      run: async ({ state, log }) => {
        const ref = state.projectRef!
        // Record versions the way the CLI does, so a future `supabase db push`
        // against an ejected project sees a consistent history.
        await sb.runQuery(
          pat,
          ref,
          `create schema if not exists supabase_migrations;
           create table if not exists supabase_migrations.schema_migrations
             (version text primary key, name text, statements text[]);`,
        )
        const applied = new Set<string>(
          ((await sb.runQuery(pat, ref, `select version from supabase_migrations.schema_migrations`)) as any[])
            ?.map((r) => String(r.version)) ?? [],
        )
        for (const m of loadMigrations()) {
          if (applied.has(m.version)) continue
          // Fresh-project storage race (CLAUDE.md gotcha): storage schema can lag
          // a few seconds — retry a failed migration once after a wait.
          try {
            await sb.runQuery(pat, ref, m.sql)
          } catch (err) {
            log(`migration ${m.name} failed once (${(err as Error).message.slice(0, 120)}), retrying in 10s…`)
            await new Promise((r) => setTimeout(r, 10_000))
            await sb.runQuery(pat, ref, m.sql)
          }
          await sb.runQuery(
            pat,
            ref,
            `insert into supabase_migrations.schema_migrations (version, name)
             values ('${m.version}', '${m.name.replace(/'/g, "''")}')
             on conflict (version) do nothing`,
          )
          log(`applied ${m.name}`)
        }
      },
    },
    {
      name: 'deployFunctions',
      run: async ({ state, log }) => {
        for (const fn of loadFunctionBundles()) {
          await sb.deployFunction({
            pat,
            ref: state.projectRef!,
            slug: fn.slug,
            files: fn.files,
            entrypointPath: fn.entrypointPath,
            verifyJwt: fn.verifyJwt,
          })
          log(`deployed ${fn.slug}`)
        }
      },
    },
    {
      name: 'mintOpenRouterKey',
      run: async ({ spec }) => {
        const { key, hash } = await or.mintTenantKey({
          provisioningKey: requireEnv('OPENROUTER_PROVISIONING_KEY'),
          name: `supanet-${spec.slug}`,
          limitUsd: Number(env('TENANT_OPENROUTER_LIMIT_USD') ?? 15),
        })
        // The runtime key is written straight into project secrets next step and
        // never persisted by the control plane; only the hash (for usage reads).
        return { openrouterKeyHash: hash, _openrouterKey: key }
      },
    },
    {
      name: 'setSecrets',
      run: async ({ state }) => {
        // Cron secret used by scheduler/event-dispatch ticks (see 0010 convention).
        const cronSecret = randomBytes(CRON_SECRET_BYTES).toString('base64url')
        await sb.setSecrets(pat, state.projectRef!, {
          OPENROUTER_API_KEY: String(state._openrouterKey ?? ''),
          CRON_SECRET: cronSecret,
        })
        return { _openrouterKey: undefined, _cronSecret: cronSecret }
      },
    },
    {
      name: 'createRailwayService',
      run: async ({ spec, state, log }) => {
        const appUrl = `https://${spec.slug}.${tenantDomain}`
        const { serviceId } = await railway.createService({
          token: requireEnv('RAILWAY_TOKEN'),
          projectId: requireEnv('RAILWAY_PROJECT_ID'),
          environmentId: requireEnv('RAILWAY_ENVIRONMENT_ID'),
          name: `tenant-${spec.slug}`,
          repo: requireEnv('TENANT_REPO'),
          branch: env('RELEASE_BRANCH') ?? 'release',
          variables: {
            VITE_SUPABASE_URL: `https://${state.projectRef}.supabase.co`,
            VITE_SUPABASE_ANON_KEY: state.anonKey!,
          },
        })
        log(`railway service ${serviceId}`)
        const { dnsTarget } = await railway.addCustomDomain({
          token: requireEnv('RAILWAY_TOKEN'),
          environmentId: requireEnv('RAILWAY_ENVIRONMENT_ID'),
          serviceId,
          domain: `${spec.slug}.${tenantDomain}`,
        })
        return { railwayServiceId: serviceId, railwayDomain: dnsTarget, appUrl }
      },
    },
    {
      name: 'wireDns',
      run: async ({ spec, state }) => {
        await cf.upsertCname({
          token: requireEnv('CLOUDFLARE_API_TOKEN'),
          zoneId: requireEnv('CLOUDFLARE_ZONE_ID'),
          name: `${spec.slug}.${tenantDomain}`,
          target: state.railwayDomain ?? `${spec.slug}.up.railway.app`,
        })
      },
    },
    {
      name: 'configureAuth',
      run: async ({ state }) => {
        // Site URL + redirect allowlist → the tenant's subdomain, so confirmation
        // and magic-link emails land on their app (CLAUDE.md auth-redirect gotcha).
        await sb.configureAuth(pat, state.projectRef!, {
          siteUrl: state.appUrl!,
          redirectUrls: [`${state.appUrl}/**`],
        })
      },
    },
    {
      name: 'verify',
      run: async ({ state, log }) => {
        // The app must serve and the tenant's Supabase must answer with the anon key.
        await waitFor(
          'tenant app to serve',
          async () => {
            const res = await fetch(state.appUrl!, { redirect: 'follow' }).catch(() => null)
            return Boolean(res?.ok)
          },
          { timeoutMs: 10 * 60_000, intervalMs: 10_000 },
        )
        const rest = await fetch(`https://${state.projectRef}.supabase.co/rest/v1/`, {
          headers: { apikey: state.anonKey! },
        })
        if (!rest.ok) throw new Error(`tenant REST API not answering (${rest.status})`)
        log(`live at ${state.appUrl}`)
      },
    },
  ]
}
