// Capability-worker jobs — the shared, import-side-effect-free logic for the
// `agent_jobs` queue that lets the main SupaNet AI hand focused work
// (OfficeCLI documents, ffmpeg media) to specialized Railway workers instead of
// running heavy binaries inside the app. The main AI creates a durable job row,
// a worker claims it atomically, runs the library, uploads outputs, and writes a
// result manifest; the AI reads the manifest and continues. See
// docs/capability-workers.md.
//
// Everything here is PURE (no db/network imports) so it can be unit-tested and
// reused verbatim by BOTH the in-app builtins (supabase/functions/_shared/
// builtins.ts) and the standalone Railway workers (workers/*), keeping the job
// contract in exactly one place.

// ---------------------------------------------------------------------------
// The capability + operation allow-list. Workers expose NARROW operations only
// (never a freeform "run this command") — the operation IS the security gate.
// ---------------------------------------------------------------------------
export const CAPABILITY_OPERATIONS: Record<string, string[]> = {
  office: [
    'office.inspect_document',
    'office.render_document',
    'office.create_docx',
    'office.convert_document',
  ],
  media: [
    'media.probe',
    'media.extract_audio',
    'media.extract_frames',
    'media.create_thumbnail',
    'media.transcode',
    'media.clip',
  ],
}

export const CAPABILITIES = Object.keys(CAPABILITY_OPERATIONS)

// Status set — small and explicit (see the build handoff).
export const JOB_STATUSES = [
  'queued',
  'claimed',
  'running',
  'completed',
  'failed',
  'retrying',
  'cancelled',
  'dead_letter',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

// A job is still "open" (pickable / in-flight) in these states.
export const OPEN_STATUSES: JobStatus[] = ['queued', 'claimed', 'running', 'retrying']

export const DEFAULT_PRIORITY = 50
export const DEFAULT_MAX_ATTEMPTS = 3

export interface ManifestRef {
  file_id?: string
  artifact_id?: string
  storage_path?: string
  mime_type?: string
  role?: string
  required?: boolean
  filename?: string
  type?: string
}

// The operation prefix (before the dot) must match the capability, so
// `media.clip` can never be smuggled onto an `office` worker.
export function capabilityForOperation(operation: string): string | null {
  const prefix = String(operation ?? '').split('.')[0]
  return prefix && CAPABILITIES.includes(prefix) ? prefix : null
}

export function isValidOperation(capability: string, operation: string): boolean {
  const ops = CAPABILITY_OPERATIONS[capability]
  return !!ops && ops.includes(operation)
}

// Returns an actionable error string, or null if the (capability, operation)
// pair is valid and internally consistent.
export function validateOperation(capability: string, operation: string): string | null {
  if (!capability) return 'A capability is required.'
  if (!CAPABILITIES.includes(capability)) {
    return `Unknown capability "${capability}". Known: ${CAPABILITIES.join(', ')}.`
  }
  if (!operation) return 'An operation is required.'
  if (capabilityForOperation(operation) !== capability) {
    return `Operation "${operation}" does not belong to capability "${capability}".`
  }
  if (!isValidOperation(capability, operation)) {
    return `Unsupported operation "${operation}". Supported: ${CAPABILITY_OPERATIONS[capability].join(', ')}.`
  }
  return null
}

// Coerce a loose input-manifest value (what the model writes) into an array of
// clean references. Drops entries that carry no locatable pointer (no file_id /
// artifact_id / storage_path), since a worker can't fetch those.
export function normalizeInputManifest(value: unknown): ManifestRef[] {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value]
  const out: ManifestRef[] = []
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const ref: ManifestRef = {}
    if (typeof r.file_id === 'string' && r.file_id.trim()) ref.file_id = r.file_id.trim()
    if (typeof r.artifact_id === 'string' && r.artifact_id.trim()) ref.artifact_id = r.artifact_id.trim()
    if (typeof r.storage_path === 'string' && r.storage_path.trim()) ref.storage_path = r.storage_path.trim()
    if (typeof r.mime_type === 'string' && r.mime_type.trim()) ref.mime_type = r.mime_type.trim()
    if (typeof r.role === 'string' && r.role.trim()) ref.role = r.role.trim()
    if (typeof r.filename === 'string' && r.filename.trim()) ref.filename = r.filename.trim()
    ref.required = r.required !== false // default true
    if (ref.file_id || ref.artifact_id || ref.storage_path) out.push(ref)
  }
  return out
}

// The stable set of file/artifact ids a job reads — the identity part of the
// idempotency key (order-independent).
export function manifestIds(manifest: ManifestRef[]): string[] {
  const ids: string[] = []
  for (const r of manifest) {
    if (r.file_id) ids.push(`f:${r.file_id}`)
    if (r.artifact_id) ids.push(`a:${r.artifact_id}`)
    if (r.storage_path) ids.push(`p:${r.storage_path}`)
  }
  return ids.sort()
}

// A small, dependency-free deterministic hash (FNV-1a, 32-bit) rendered as hex —
// enough to key idempotency without pulling in a crypto import (keeps this
// module side-effect-free and usable in both Deno and Node workers).
export function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// idempotency key = workspace + operation + sorted input ids + normalized
// instructions. Repeating the exact same request won't mint duplicate files.
export function buildIdempotencyKey(opts: {
  workspaceId?: string | null
  operation: string
  manifest: ManifestRef[]
  instructions?: string | null
  parameters?: unknown
}): string {
  const parts = [
    opts.workspaceId ?? '',
    opts.operation,
    manifestIds(opts.manifest).join(','),
    (opts.instructions ?? '').trim().replace(/\s+/g, ' ').toLowerCase(),
    opts.parameters ? stableJson(opts.parameters) : '',
  ]
  return `${opts.operation}:${stableHash(parts.join('|'))}`
}

// Deterministic JSON.stringify (sorted keys) so parameter order never changes
// the idempotency key.
export function stableJson(value: unknown): string {
  const seen = new Set<unknown>()
  const walk = (v: unknown): unknown => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return null
      seen.add(v)
      if (Array.isArray(v)) return v.map(walk)
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) sorted[k] = walk(obj[k])
      return sorted
    }
    return v
  }
  return JSON.stringify(walk(value))
}

// Exponential backoff for retryable failures: 30s → 2m → 10m, then capped.
const BACKOFF_SECONDS = [30, 120, 600]
export function backoffSeconds(attempt: number): number {
  if (attempt <= 1) return BACKOFF_SECONDS[0]
  const idx = Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)
  return BACKOFF_SECONDS[idx]
}

// Decide what a failure means: a permanent error → failed (no retry); a
// transient error under max_attempts → retrying after backoff; otherwise
// dead_letter. Pure so both the worker and tests agree on the policy.
export function nextFailureState(
  attempts: number,
  maxAttempts: number,
  permanent: boolean,
): { status: 'failed' | 'retrying' | 'dead_letter'; retryInSeconds: number | null } {
  if (permanent) return { status: 'failed', retryInSeconds: null }
  if (attempts >= maxAttempts) return { status: 'dead_letter', retryInSeconds: null }
  return { status: 'retrying', retryInSeconds: backoffSeconds(attempts) }
}

export function clampPriority(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_PRIORITY
  return Math.max(0, Math.min(100, Math.round(n)))
}

export interface AgentJobRow {
  id?: string
  capability?: string
  operation?: string
  status?: string
  priority?: number
  instructions?: string | null
  input_manifest?: unknown
  result_manifest?: unknown
  parameters?: unknown
  error?: string | null
  attempts?: number
  max_attempts?: number
  worker_id?: string | null
  created_at?: string | null
  started_at?: string | null
  completed_at?: string | null
}

// Turn a result_manifest into a short list the main AI can narrate.
export function summarizeResult(manifest: unknown): string {
  const arr = Array.isArray(manifest) ? manifest : []
  if (!arr.length) return 'No output files were reported.'
  const lines = arr.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>
    const kind = r.type === 'artifact' || r.artifact_id ? 'artifact' : 'file'
    const id = r.file_id ?? r.artifact_id ?? '(no id)'
    const role = r.role ? ` [${r.role}]` : ''
    const name = r.filename ? ` ${r.filename}` : ''
    return `- ${kind}${name}${role} — ${id}`
  })
  return lines.join('\n')
}

// A compact, model-facing summary of a job's current state.
export function summarizeJob(job: AgentJobRow): string {
  const lines = [
    `Job ${job.id ?? '(pending)'} — ${job.operation ?? job.capability ?? '?'}`,
    `status: ${job.status ?? 'unknown'}` +
      (job.attempts != null ? ` (attempt ${job.attempts}/${job.max_attempts ?? DEFAULT_MAX_ATTEMPTS})` : ''),
  ]
  if (job.error) lines.push(`error: ${job.error}`)
  if (job.status === 'completed') {
    lines.push('outputs:')
    lines.push(summarizeResult(job.result_manifest))
  }
  return lines.join('\n')
}
