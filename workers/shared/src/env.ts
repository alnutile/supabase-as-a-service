// Worker configuration — the PORTABLE contract. Every provider-specific value is
// an ordinary environment variable, so the same image runs unchanged on local
// Docker Compose, Railway, Fly.io, Render, Kubernetes, or a VPS. NOTHING here is
// Railway-specific: no Railway hostnames, project/service ids, tokens, or SDK.
// (These are plain container env vars — the SUPABASE_ prefix is fine; the "no
// SUPABASE_ prefix" rule only applies to `supabase secrets set`.)
export interface WorkerEnv {
  supabaseUrl: string
  serviceRoleKey: string
  databaseUrl: string | null
  storageBucket: string
  capability: string | null
  workerId: string
  pollIntervalMs: number
  healthPort: number
  leaseSeconds: number
  maxAttempts: number
  logLevel: string
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

export function loadEnv(): WorkerEnv {
  // Provider-neutral instance label: use an explicit WORKER_ID, else derive one
  // (works the same on any platform — HOSTNAME is set by Docker/K8s/Railway/etc).
  const host = process.env.WORKER_ID || process.env.HOSTNAME || 'worker'
  return {
    supabaseUrl: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    databaseUrl: process.env.DATABASE_URL || null, // optional direct-Postgres escape hatch
    storageBucket: process.env.STORAGE_BUCKET || 'files',
    capability: process.env.WORKER_CAPABILITY || null,
    workerId: process.env.WORKER_ID || `${host}-${Math.random().toString(16).slice(2, 8)}`,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 3000,
    healthPort: Number(process.env.PORT) || Number(process.env.HEALTH_PORT) || 8080,
    leaseSeconds: Number(process.env.JOB_LEASE_SECONDS) || 120,
    maxAttempts: Number(process.env.MAX_ATTEMPTS) || 3,
    logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  }
}
