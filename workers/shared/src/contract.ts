// The job CONTRACT shared by every capability worker. This is a Node/ESM copy of
// the pure logic in supabase/functions/_shared/agent_jobs.ts (the app side) —
// the app and the workers MUST agree on capability/operation names, statuses,
// and backoff, so if you change one, change the other. Kept dependency-free.

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

// 30s → 2m → 10m, then capped — retryable failures back off exponentially.
const BACKOFF_SECONDS = [30, 120, 600]
export function backoffSeconds(attempt: number): number {
  if (attempt <= 1) return BACKOFF_SECONDS[0]
  const idx = Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)
  return BACKOFF_SECONDS[idx]
}

export function isValidOperation(capability: string, operation: string): boolean {
  const ops = CAPABILITY_OPERATIONS[capability]
  return !!ops && ops.includes(operation)
}

// Decide what a failure means: permanent → failed (no retry); transient under
// max_attempts → retrying after backoff; otherwise dead_letter. Mirrors the app
// side (supabase/functions/_shared/agent_jobs.ts) so both agree on the policy.
export function nextFailureState(
  attempts: number,
  maxAttempts: number,
  permanent: boolean,
): { status: 'failed' | 'retrying' | 'dead_letter'; retryInSeconds: number | null } {
  if (permanent) return { status: 'failed', retryInSeconds: null }
  if (attempts >= maxAttempts) return { status: 'dead_letter', retryInSeconds: null }
  return { status: 'retrying', retryInSeconds: backoffSeconds(attempts) }
}

// Enforce tenant isolation: an input resource must belong to the job's owner.
export function ownsResource(ownerId: string, resourceOwnerId: string | null | undefined): boolean {
  return !!resourceOwnerId && resourceOwnerId === ownerId
}

// A worker distinguishes retryable (transient) from permanent failures. Throw
// PermanentError for anything the same inputs will never recover from
// (unsupported file type, missing required input, malformed document) — those go
// straight to `failed`, no retry.
export class PermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentError'
  }
}

export interface ManifestRef {
  file_id?: string
  artifact_id?: string
  storage_path?: string
  mime_type?: string
  role?: string
  required?: boolean
  filename?: string
}

export interface OutputRef {
  file_id?: string
  artifact_id?: string
  type?: 'file' | 'artifact'
  role?: string
  mime_type?: string
  filename?: string
}
