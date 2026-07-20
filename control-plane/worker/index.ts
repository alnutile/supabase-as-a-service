// The provisioning worker — the muscle behind signup. Polls the control-plane
// Supabase for queued provisioning_jobs (lease-based claim RPC, same pattern as
// the main app's agent_jobs) and runs the engine pipeline for each. Persists
// the step checklist after every step, which is what makes the signup waiting
// page tick live.
//
// Runs anywhere Node + this repo checkout exist: locally (`npm run worker`),
// or as a Docker service on Railway (provider-neutral, like workers/).
// Env (see ../.env.example): CONTROL_PLANE_SUPABASE_URL,
// CONTROL_PLANE_SERVICE_ROLE_KEY, plus all the engine credentials.

import { createClient } from '@supabase/supabase-js'
import { requireEnv, env } from '../engine/env.ts'
import { runPipeline } from '../engine/pipeline.ts'
import { buildSteps } from '../engine/steps.ts'
import type { StepRecord, TenantState } from '../engine/types.ts'

const db = createClient(requireEnv('CONTROL_PLANE_SUPABASE_URL'), requireEnv('CONTROL_PLANE_SERVICE_ROLE_KEY'))

const POLL_MS = Number(env('POLL_INTERVAL_MS') ?? 5_000)
const LEASE_SECONDS = 900
// verifyCustomDomain alone can poll for 30 min — heartbeat keeps the lease alive.
const HEARTBEAT_MS = (LEASE_SECONDS / 3) * 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Job {
  id: string
  tenant_id: string
  steps: StepRecord[]
  state: TenantState
}

async function event(tenantId: string, type: string, detail: Record<string, unknown> = {}) {
  await db.from('cp_events').insert({ tenant_id: tenantId, type, detail })
}

async function runJob(job: Job): Promise<void> {
  const { data: tenant } = await db
    .from('tenants')
    .select('id, slug, name, admin_email, status')
    .eq('id', job.tenant_id)
    .single()
  if (!tenant) {
    await db.from('provisioning_jobs').update({ status: 'error', error: 'tenant row missing' }).eq('id', job.id)
    return
  }

  console.log(`▶ job ${job.id} → tenant "${tenant.slug}"`)
  await db.from('tenants').update({ status: 'provisioning' }).eq('id', tenant.id)
  await event(tenant.id, 'provision.started', { job_id: job.id })

  const heartbeat = setInterval(() => {
    db.from('provisioning_jobs')
      .update({ lease_expires_at: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString() })
      .eq('id', job.id)
      .then(({ error }) => error && console.error('heartbeat failed', error.message))
  }, HEARTBEAT_MS)

  try {
    const priorOk = (job.steps ?? []).filter((s) => s.status === 'ok')
    const result = await runPipeline({
      spec: { slug: tenant.slug, name: tenant.name, adminEmail: tenant.admin_email },
      steps: buildSteps(),
      completed: priorOk.map((s) => s.name),
      initialState: job.state ?? {},
      log: (m) => console.log(`  [${tenant.slug}] ${m}`),
      persist: async ({ state, steps }) => {
        // Keep prior-run ok records so the checklist stays complete across resumes.
        const merged = [...priorOk.filter((p) => !steps.some((n) => n.name === p.name)), ...steps]
        await db.from('provisioning_jobs').update({ state, steps: merged }).eq('id', job.id)
      },
    })

    if (result.ok) {
      await db.from('provisioning_jobs').update({ status: 'ok', error: null }).eq('id', job.id)
      await db
        .from('tenants')
        .update({
          status: 'active',
          project_ref: result.state.projectRef ?? null,
          railway_service_id: result.state.railwayServiceId ?? null,
          openrouter_key_hash: result.state.openrouterKeyHash ?? null,
          app_url: result.state.appUrl ?? null,
        })
        .eq('id', tenant.id)
      await event(tenant.id, 'provision.completed', { app_url: result.state.appUrl })
      console.log(`✓ tenant "${tenant.slug}" live at ${result.state.appUrl}`)
      // TODO(slice 4): send the "your workspace is ready" email here.
    } else {
      const failed = result.steps.at(-1)
      await db
        .from('provisioning_jobs')
        .update({ status: 'error', error: `${result.failedStep}: ${failed?.error ?? 'unknown'}` })
        .eq('id', job.id)
      await db.from('tenants').update({ status: 'failed' }).eq('id', tenant.id)
      await event(tenant.id, 'provision.failed', { step: result.failedStep, error: failed?.error })
      console.error(`✗ tenant "${tenant.slug}" failed at ${result.failedStep}: ${failed?.error}`)
    }
  } finally {
    clearInterval(heartbeat)
  }
}

console.log(`SupaNet provisioning worker up — polling every ${POLL_MS}ms`)
for (;;) {
  try {
    const { data, error } = await db.rpc('claim_provisioning_job', { p_lease_seconds: LEASE_SECONDS })
    if (error) {
      console.error('claim failed:', error.message)
    } else {
      const job = (Array.isArray(data) ? data[0] : data) as Job | undefined
      if (job) {
        await runJob(job)
        continue // check for the next job immediately
      }
    }
  } catch (err) {
    console.error('worker loop error:', err instanceof Error ? err.message : err)
  }
  await sleep(POLL_MS)
}
