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
        // The password is never needed again (the Management API covers all later
        // steps), so it is deliberately NOT returned into persisted state.
        return { projectRef: ref }
      },
    },
    {
      name: 'waitForHealthy',
      run: async ({ state, log }) => {
        const ref = state.projectRef!
        // A just-created project can 404 on GET for a short window (eventual
        // consistency — bit the first live customer signup). Any lookup error
        // during the wait means "not ready yet", never "failed".
        await waitFor(
          'project ACTIVE_HEALTHY',
          async () => {
            try {
              return (await sb.projectStatus(pat, ref)) === 'ACTIVE_HEALTHY'
            } catch (err) {
              log(`project not queryable yet (${(err as Error).message.slice(0, 80)}) — waiting`)
              return false
            }
          },
          { timeoutMs: 10 * 60_000 },
        )
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
        // Fresh-project storage race (CLAUDE.md gotcha): the storage schema can
        // lag project-healthy by minutes, and migration 0001 writes to
        // storage.buckets. Wait for it explicitly before applying anything.
        await waitFor(
          'storage schema',
          async () => {
            const rows = (await sb.runQuery(pat, ref, `select to_regclass('storage.buckets') is not null as ready`)) as any[]
            return Boolean(rows?.[0]?.ready)
          },
          { timeoutMs: 5 * 60_000, intervalMs: 10_000 },
        )
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
          // Apply + record in ONE request: the query endpoint is transactional
          // per request (verified on tenant zero), so the migration and its
          // version row commit atomically — a failure can never leave a
          // migration applied-but-unrecorded.
          const sql = `${m.sql}
            ;insert into supabase_migrations.schema_migrations (version, name)
             values ('${m.version}', '${m.name.replace(/'/g, "''")}')
             on conflict (version) do nothing;`
          // Transient-failure retry (no partial state on failure, see above).
          let lastErr: unknown
          let done = false
          for (let attempt = 1; attempt <= 3 && !done; attempt++) {
            try {
              await sb.runQuery(pat, ref, sql)
              done = true
            } catch (err) {
              lastErr = err
              log(`migration ${m.name} attempt ${attempt} failed (${(err as Error).message.slice(0, 120)}), retrying in 15s…`)
              await new Promise((r) => setTimeout(r, 15_000))
            }
          }
          if (!done) throw lastErr
          log(`applied ${m.name}`)
          // Pace under the Management API's ~60 req/min limit.
          await new Promise((r) => setTimeout(r, 1_200))
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
      run: async () => {
        // Kept as a recorded step name for resume-compat; the actual mint moved
        // into setSecrets so the runtime key never crosses a persist boundary.
      },
    },
    {
      name: 'setSecrets',
      run: async ({ spec, state }) => {
        // Mint + store in ONE step: the runtime key exists only in this stack
        // frame — it goes straight into the tenant project's secrets and is
        // never returned into persisted state (only the hash, for usage reads).
        const { key, hash } = await or.mintTenantKey({
          provisioningKey: requireEnv('OPENROUTER_PROVISIONING_KEY'),
          name: `supanet-${spec.slug}`,
          limitUsd: Number(env('TENANT_OPENROUTER_LIMIT_USD') ?? 15),
        })
        // Cron secret used by scheduler/event-dispatch ticks (see 0010 convention).
        const cronSecret = randomBytes(CRON_SECRET_BYTES).toString('base64url')
        await sb.setSecrets(pat, state.projectRef!, {
          OPENROUTER_API_KEY: key,
          CRON_SECRET: cronSecret,
        })
        return { openrouterKeyHash: hash }
      },
    },
    {
      name: 'createRailwayService',
      run: async ({ spec, state, log }) => {
        const appUrl = `https://${spec.slug}.${tenantDomain}`
        const token = requireEnv('RAILWAY_TOKEN')
        const projectId = requireEnv('RAILWAY_PROJECT_ID')
        const name = `tenant-${spec.slug}`
        // Idempotent: a prior partial run may have created the service already.
        let serviceId = await railway.findServiceByName(token, projectId, name)
        if (serviceId) {
          log(`railway service ${serviceId} (already exists, reusing)`)
        } else {
          const created = await railway.createService({
            token,
            projectId,
            environmentId: requireEnv('RAILWAY_ENVIRONMENT_ID'),
            name,
            repo: requireEnv('TENANT_REPO'),
            branch: env('RELEASE_BRANCH') ?? 'release',
            variables: {
              VITE_SUPABASE_URL: `https://${state.projectRef}.supabase.co`,
              VITE_SUPABASE_ANON_KEY: state.anonKey!,
            },
          })
          serviceId = created.serviceId
          log(`railway service ${serviceId}`)
        }
        // Pin to the release branch — serviceCreate's branch field alone does
        // not make the first build track it (observed on tenant zero).
        await railway.connectBranch({
          token,
          serviceId,
          repo: requireEnv('TENANT_REPO'),
          branch: env('RELEASE_BRANCH') ?? 'release',
        })
        // Public networking: without a generated service domain the app is
        // unreachable and custom-domain certs never validate.
        const { domain } = await railway.ensureServiceDomain({
          token,
          projectId,
          environmentId: requireEnv('RAILWAY_ENVIRONMENT_ID'),
          serviceId,
        })
        log(`service domain ${domain}`)
        return { railwayServiceId: serviceId, railwayServiceDomain: domain, appUrl }
      },
    },
    {
      name: 'attachTenantDomain',
      run: async ({ spec, state, log }) => {
        const opts = {
          token: requireEnv('RAILWAY_TOKEN'),
          projectId: requireEnv('RAILWAY_PROJECT_ID'),
          environmentId: requireEnv('RAILWAY_ENVIRONMENT_ID'),
          serviceId: state.railwayServiceId!,
          domain: `${spec.slug}.${tenantDomain}`,
        }
        // Idempotent: a prior partial run may have attached the domain already.
        const existing = await railway.getCustomDomain(opts)
        if (existing) {
          log(`domain ${opts.domain} already attached (${existing.certificateStatus ?? 'status unknown'})`)
          return { railwayDomain: existing.dnsTarget }
        }
        const { dnsTarget } = await railway.addCustomDomain(opts)
        return { railwayDomain: dnsTarget }
      },
    },
    {
      name: 'wireDns',
      run: async ({ spec, state, log }) => {
        const cfOpts = { token: requireEnv('CLOUDFLARE_API_TOKEN'), zoneId: requireEnv('CLOUDFLARE_ZONE_ID') }
        await cf.upsertCname({
          ...cfOpts,
          name: `${spec.slug}.${tenantDomain}`,
          target: state.railwayDomain ?? `${spec.slug}.up.railway.app`,
        })
        // Railway also requires an ownership-verification TXT record; without it
        // the cert sits in VALIDATING_OWNERSHIP forever (tenant-zero lesson).
        const dom = await railway.getCustomDomain({
          token: requireEnv('RAILWAY_TOKEN'),
          projectId: requireEnv('RAILWAY_PROJECT_ID'),
          environmentId: requireEnv('RAILWAY_ENVIRONMENT_ID'),
          serviceId: state.railwayServiceId!,
          domain: `${spec.slug}.${tenantDomain}`,
        })
        if (dom?.verificationDnsHost && dom.verificationToken) {
          await cf.upsertTxt({
            ...cfOpts,
            name: `${dom.verificationDnsHost}.${tenantDomain}`,
            content: dom.verificationToken,
          })
          log(`verification TXT ${dom.verificationDnsHost}.${tenantDomain} set`)
        }
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
        // Verify the APP on Railway's own service domain — deterministic and
        // fast. The custom domain (cert issuance, DNS caches) is verified
        // separately below so a slow Let's Encrypt never re-runs this.
        const serviceUrl = state.railwayServiceDomain
          ? `https://${state.railwayServiceDomain}`
          : state.appUrl!
        await waitFor(
          'tenant app to serve',
          async () => {
            const res = await fetch(serviceUrl, { redirect: 'follow' }).catch(() => null)
            return Boolean(res?.ok)
          },
          { timeoutMs: 10 * 60_000, intervalMs: 10_000 },
        )
        // NOT /rest/v1/ root — on new projects that endpoint demands a secret
        // key ("Only secret API keys can be used for this endpoint"). The auth
        // health check validates gateway + anon key without that restriction.
        const health = await fetch(`https://${state.projectRef}.supabase.co/auth/v1/health`, {
          headers: { apikey: state.anonKey! },
        })
        if (!health.ok) throw new Error(`tenant API gateway not answering (${health.status})`)
        log(`app live at ${serviceUrl}`)
      },
    },
    {
      name: 'verifyCustomDomain',
      run: async ({ state, log }) => {
        // Cert issuance is external (Let's Encrypt via Railway) and can take a
        // while — especially after failed-validation rate limits. Patient poll;
        // a timeout here resumes with ONLY this step on re-run.
        await waitFor(
          `custom domain ${state.appUrl} to serve over TLS`,
          async () => {
            const res = await fetch(state.appUrl!, { redirect: 'follow' }).catch(() => null)
            return Boolean(res?.ok)
          },
          { timeoutMs: 30 * 60_000, intervalMs: 20_000 },
        )
        log(`live at ${state.appUrl}`)
      },
    },
  ]
}
