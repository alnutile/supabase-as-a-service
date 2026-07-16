// The capability-worker run loop: poll → atomically claim a job → download &
// verify inputs → run the operation handler → upload outputs → write the result
// manifest → mark completed (or retry/fail). Includes a lease + heartbeat so a
// crashed worker's job can be recovered, a tiny HTTP health/ready endpoint,
// structured JSON logs, temp-file cleanup, an append-only agent_job_events
// timeline, and graceful shutdown. Reusable by every worker; each worker only
// supplies its operation handlers (see office/media index.ts).
//
// PROVIDER-NEUTRAL: this talks only to Postgres (via the Supabase service role)
// and Storage. No Railway APIs, hostnames, or SDKs — the same image runs on
// local Docker Compose, Railway, Fly, Render, K8s, or a VPS.
import http from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadEnv, type WorkerEnv } from './env.js'
import {
  isValidOperation,
  nextFailureState,
  PermanentError,
  type ManifestRef,
  type OutputRef,
} from './contract.js'
import { cleanupTmpDir, downloadInput, makeJobTmpDir, setStorageBucket, type ResolvedInput } from './storage.js'
import type { AgentJob, JobContext, WorkerConfig } from './types.js'

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 }
let minLevel = 20

function log(level: string, worker: string, message: string, extra: Record<string, unknown> = {}) {
  if ((LEVELS[level] ?? 20) < minLevel) return
  // Structured logs; never include document contents / prompts / tokens / env.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, worker, message, ...extra }))
}

// Append a row to the job's lifecycle timeline (best-effort; a logging failure
// must never fail the job).
async function recordEvent(
  db: SupabaseClient,
  jobId: string,
  workerId: string,
  eventType: string,
  message: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.from('agent_job_events').insert({ job_id: jobId, worker_id: workerId, event_type: eventType, message, data })
  } catch {
    // ignore
  }
}

export async function startWorker(config: WorkerConfig): Promise<void> {
  const env = loadEnv()
  minLevel = LEVELS[env.logLevel] ?? 20
  setStorageBucket(env.storageBucket)

  // A worker's capability is fixed by the image, but WORKER_CAPABILITY can pin it
  // explicitly (and must agree if set).
  if (env.capability && env.capability !== config.capability) {
    throw new Error(`WORKER_CAPABILITY=${env.capability} but this is the ${config.capability} worker.`)
  }

  const db = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  let running = true
  let ready = false
  let activeJobId: string | null = null

  startHealthServer(config, env, () => activeJobId, () => ready)

  const shutdown = (sig: string) => {
    log('info', config.capability, `Received ${sig}, finishing current job then exiting`, {})
    running = false
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  ready = true
  log('info', config.capability, 'Worker started', {
    worker_id: env.workerId,
    version: config.version,
    storage_bucket: env.storageBucket,
    operations: Object.keys(config.handlers),
  })

  while (running) {
    let claimed = false
    try {
      const job = await claimJob(db, config.capability, env)
      if (job) {
        claimed = true
        activeJobId = job.id
        await processJob(db, config, env, job)
        activeJobId = null
      }
    } catch (err) {
      log('error', config.capability, 'Loop error', { error: errText(err) })
    }
    if (!running) break
    // Recover leases occasionally + idle-sleep when there was nothing to do.
    if (!claimed) {
      await recoverStaleJobs(db, env)
      await sleep(env.pollIntervalMs)
    }
  }

  log('info', config.capability, 'Worker stopped', { worker_id: env.workerId })
  process.exit(0)
}

async function claimJob(db: SupabaseClient, capability: string, env: WorkerEnv): Promise<AgentJob | null> {
  const { data, error } = await db.rpc('claim_agent_job', {
    p_capability: capability,
    p_worker_id: env.workerId,
    p_lease_seconds: env.leaseSeconds,
  })
  if (error) {
    log('error', capability, 'Claim RPC failed', { error: error.message })
    return null
  }
  const rows = (data as AgentJob[]) || []
  return rows.length ? rows[0] : null
}

async function processJob(db: SupabaseClient, config: WorkerConfig, env: WorkerEnv, job: AgentJob): Promise<void> {
  const cap = config.capability
  log('info', cap, 'Claimed job', { job_id: job.id, operation: job.operation, attempt: job.attempts })
  await recordEvent(db, job.id, env.workerId, 'claimed', `Claimed by ${env.workerId}`, { attempt: job.attempts })

  // Cancellation check — don't start expensive work on a cancelled job.
  if (job.status === 'cancelled') {
    log('info', cap, 'Job was cancelled before start', { job_id: job.id })
    return
  }

  const handler = config.handlers[job.operation]
  if (!handler || !isValidOperation(cap, job.operation)) {
    await markFailed(db, env, job, `Unsupported operation "${job.operation}" for the ${cap} worker.`, 'invalid_operation')
    return
  }
  if (!job.requested_by) {
    await markFailed(db, env, job, 'Job has no owner; cannot verify input ownership.', 'no_owner')
    return
  }

  await db
    .from('agent_jobs')
    .update({ status: 'running', heartbeat_at: new Date().toISOString() })
    .eq('id', job.id)
  await recordEvent(db, job.id, env.workerId, 'running', 'Started processing')

  const heartbeatMs = Math.max(15000, Math.floor((env.leaseSeconds * 1000) / 3))
  const heartbeat = setInterval(() => {
    const lease = new Date(Date.now() + env.leaseSeconds * 1000).toISOString()
    db.from('agent_jobs')
      .update({ heartbeat_at: new Date().toISOString(), lease_expires_at: lease })
      .eq('id', job.id)
      .eq('worker_id', env.workerId)
      .then(
        () => {},
        () => {},
      )
  }, heartbeatMs)

  const tmpDir = await makeJobTmpDir(job.id)
  try {
    const manifest = Array.isArray(job.input_manifest) ? (job.input_manifest as ManifestRef[]) : []
    const inputs: ResolvedInput[] = []
    for (const ref of manifest) {
      if (ref && (ref.file_id || ref.storage_path || ref.artifact_id)) {
        inputs.push(await downloadInput(db, ref, job.requested_by, tmpDir))
      } else if (ref?.required) {
        throw new PermanentError('A required input reference is missing a locator (file_id/storage_path/artifact_id).')
      }
    }

    const ctx: JobContext = {
      db,
      job,
      ownerId: job.requested_by,
      instructions: job.instructions ?? '',
      parameters: (job.parameters as Record<string, unknown>) ?? {},
      inputs,
      tmpDir,
      log: (message, extra) => {
        log('info', cap, message, { job_id: job.id, ...extra })
        void recordEvent(db, job.id, env.workerId, 'progress', message, extra ?? {})
      },
    }

    const outputs: OutputRef[] = await handler(ctx)
    await markCompleted(db, env, job, outputs)
    log('info', cap, 'Job completed', { job_id: job.id, outputs: outputs.length })
  } catch (err) {
    await handleFailure(db, env, job, err)
  } finally {
    clearInterval(heartbeat)
    await cleanupTmpDir(tmpDir)
  }
}

async function markCompleted(db: SupabaseClient, env: WorkerEnv, job: AgentJob, outputs: OutputRef[]): Promise<void> {
  await db
    .from('agent_jobs')
    .update({
      status: 'completed',
      result_manifest: outputs,
      completed_at: new Date().toISOString(),
      heartbeat_at: null,
      lease_expires_at: null,
      error: null,
      error_code: null,
    })
    .eq('id', job.id)
  await recordEvent(db, job.id, env.workerId, 'completed', `Produced ${outputs.length} output(s)`, {
    outputs: outputs.length,
  })
}

async function markFailed(db: SupabaseClient, env: WorkerEnv, job: AgentJob, message: string, code: string): Promise<void> {
  await db
    .from('agent_jobs')
    .update({
      status: 'failed',
      error: message,
      error_code: code,
      completed_at: new Date().toISOString(),
      heartbeat_at: null,
      lease_expires_at: null,
    })
    .eq('id', job.id)
  await recordEvent(db, job.id, env.workerId, 'failed', message, { error_code: code })
  log('warn', job.capability, 'Job failed (permanent)', { job_id: job.id, error: message })
}

// Retryable → status retrying + backoff; permanent → failed; over max_attempts →
// dead_letter. The policy is the shared pure nextFailureState().
async function handleFailure(db: SupabaseClient, env: WorkerEnv, job: AgentJob, err: unknown): Promise<void> {
  const message = errText(err)
  const permanent = err instanceof PermanentError
  const decision = nextFailureState(job.attempts, job.max_attempts, permanent)

  if (decision.status === 'failed') {
    await markFailed(db, env, job, message, 'permanent')
    return
  }
  if (decision.status === 'dead_letter') {
    await db
      .from('agent_jobs')
      .update({
        status: 'dead_letter',
        error: message,
        error_code: 'max_attempts',
        completed_at: new Date().toISOString(),
        heartbeat_at: null,
        lease_expires_at: null,
      })
      .eq('id', job.id)
    await recordEvent(db, job.id, env.workerId, 'dead_letter', message, { attempts: job.attempts })
    log('error', job.capability, 'Job dead-lettered', { job_id: job.id, error: message })
    return
  }
  const delay = decision.retryInSeconds ?? 30
  const availableAt = new Date(Date.now() + delay * 1000).toISOString()
  await db
    .from('agent_jobs')
    .update({
      status: 'retrying',
      error: message,
      error_code: 'transient',
      available_at: availableAt,
      heartbeat_at: null,
      lease_expires_at: null,
      worker_id: null,
    })
    .eq('id', job.id)
  await recordEvent(db, job.id, env.workerId, 'retrying', message, { retry_in_seconds: delay })
  log('warn', job.capability, 'Job will retry', { job_id: job.id, error: message, retry_in_seconds: delay })
}

async function recoverStaleJobs(db: SupabaseClient, env: WorkerEnv): Promise<void> {
  const { error } = await db.rpc('recover_stale_agent_jobs', { p_lease_seconds: env.leaseSeconds })
  if (error) log('warn', 'shared', 'Lease recovery failed', { error: error.message })
}

function startHealthServer(
  config: WorkerConfig,
  env: WorkerEnv,
  activeJob: () => string | null,
  isReady: () => boolean,
): void {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/health' || url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          worker: `${config.capability}-worker`,
          capability: config.capability,
          version: config.version,
          worker_id: env.workerId,
          active_job: activeJob(),
        }),
      )
      return
    }
    if (url === '/ready') {
      const ready = isReady()
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ready }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(env.healthPort, () => {
    log('info', config.capability, 'Health endpoint listening', { port: env.healthPort })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
