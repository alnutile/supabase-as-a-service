// Pure logic for the tenant backup job (backup/index.ts). No I/O here so it is
// unit-tested in plan.test.ts: which tenants to back up, where each artifact
// lands in S3, and which storage objects the mirror can skip.
//
// S3 layout (prefix-first so a lifecycle rule can target each class):
//   db/<ref>/<stamp>.dump            pg_dump custom format, one per run
//   storage/<ref>/<bucket>/<name>    mirror of the project's Storage objects
//   runs/<stamp>.json                summary of every run (ok + failures)

export interface Tenant {
  id: string | null
  slug: string
  ref: string
}

// Tenants whose project still exists. `canceled` stays in on purpose: the
// project is live until the teardown pauses it, and a canceled customer is the
// one most likely to ask for their data back.
export const BACKUP_STATUSES = ['active', 'past_due', 'canceled'] as const

const REF_RE = /^[a-z0-9]{20}$/

export function isProjectRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_RE.test(ref)
}

// Control-plane rows + the operator's extra refs (the origin project, the
// control plane itself), deduped by ref. Bad refs are dropped, not trusted.
export function resolveTenants(
  rows: Array<{ id?: string | null; slug?: string | null; project_ref?: string | null }>,
  extraRefs: string[] = [],
): Tenant[] {
  const out = new Map<string, Tenant>()
  for (const r of rows) {
    if (!isProjectRef(r.project_ref)) continue
    out.set(r.project_ref, { id: r.id ?? null, slug: r.slug || r.project_ref, ref: r.project_ref })
  }
  for (const ref of extraRefs) {
    if (isProjectRef(ref) && !out.has(ref)) out.set(ref, { id: null, slug: ref, ref })
  }
  return [...out.values()]
}

export function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// 2026-09-29T07:00:00.123Z → 2026-09-29T07-00-00Z (sortable, no colons in keys)
export function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
}

export function dumpKey(prefix: string, ref: string, runStamp: string): string {
  return joinKey(prefix, 'db', ref, `${runStamp}.dump`)
}

export function storagePrefix(prefix: string, ref: string): string {
  return joinKey(prefix, 'storage', ref) + '/'
}

export function storageKey(prefix: string, ref: string, bucket: string, name: string): string {
  return joinKey(prefix, 'storage', ref, bucket, name)
}

export function runKey(prefix: string, runStamp: string): string {
  return joinKey(prefix, 'runs', `${runStamp}.json`)
}

function joinKey(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

export interface StorageObject {
  bucket: string
  name: string
  size: number | null
  updatedAt: string | null
}

export interface MirroredObject {
  size: number
  lastModified: Date
}

// The mirror is incremental: an object is re-copied only when S3 lacks it, the
// size differs, or Supabase changed it after the mirrored copy was written.
// Unknown size/time means "copy" — a redundant upload beats a stale backup.
export function needsCopy(obj: StorageObject, mirrored: MirroredObject | undefined): boolean {
  if (!mirrored) return true
  if (obj.size === null || obj.size !== mirrored.size) return true
  if (!obj.updatedAt) return true
  const changed = Date.parse(obj.updatedAt)
  return !Number.isFinite(changed) || changed > mirrored.lastModified.getTime()
}

// Supabase Storage object path → URL path, keeping `/` separators.
export function encodeObjectPath(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/')
}

// Values interpolated into Management-API SQL (the endpoint takes no bind
// params). Only ever used for identifiers we read back from the database.
export function sqlLiteral(v: string | null): string {
  return v === null ? 'null' : `'${v.replace(/'/g, "''")}'`
}

// The Management API's temporary logins (cli_login_postgres,
// cli_login_supabase_read_only_user) do NOT inherit their target role's
// privileges — the Supabase CLI connects and then `SET ROLE`s into the target.
// pg_dump does the same via --role; without it every schema is permission-denied.
export function targetRole(loginRole: string): string {
  return loginRole.replace(/^cli_login_/, '') || loginRole
}

// pg_dump's -n list. Application data lives in public (incl. the ut_* user
// tables); auth + storage hold users and object metadata; supabase_migrations
// records which migrations a restore target already has.
export const DEFAULT_SCHEMAS = ['public', 'auth', 'storage', 'supabase_migrations']
