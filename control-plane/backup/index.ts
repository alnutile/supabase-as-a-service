// Nightly tenant backups → S3. A run-to-completion job (Railway cron service,
// or `npm run backup` anywhere with pg_dump 17 on PATH): for every live tenant
// in the control plane it
//   1. pg_dumps the application schemas (custom format) to db/<ref>/<stamp>.dump
//   2. mirrors the project's Storage objects incrementally to storage/<ref>/…
// then writes runs/<stamp>.json and exits non-zero if any tenant failed.
//
// Needs only the org PAT for Supabase: the provisioner throws tenant DB
// passwords away, so each dump authenticates with a temporary login role
// minted by the Management API (tried read-only first) through the IPv4
// Supavisor pooler, and Storage is read with the project's service-role key
// fetched the same way. Env: see ../.env.example "Backups".

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { env, requireEnv } from '../engine/env.ts'
import * as sb from '../engine/supabaseApi.ts'
import {
  BACKUP_STATUSES,
  DEFAULT_SCHEMAS,
  dumpKey,
  encodeObjectPath,
  needsCopy,
  parseList,
  resolveTenants,
  runKey,
  sqlLiteral,
  stamp,
  storageKey,
  storagePrefix,
  type MirroredObject,
  type StorageObject,
  type Tenant,
} from './plan.ts'

const pat = requireEnv('SUPANET_MGMT_PAT')
const bucket = requireEnv('BACKUP_S3_BUCKET')
const prefix = env('BACKUP_S3_PREFIX') ?? ''
const controlPlaneRef = env('CONTROL_PLANE_REF')
const schemas = parseList(env('BACKUP_SCHEMAS')).length ? parseList(env('BACKUP_SCHEMAS')) : DEFAULT_SCHEMAS
const skipStorage = env('BACKUP_SKIP_STORAGE') === 'true'
const alertWebhook = env('BACKUP_ALERT_WEBHOOK')
const STORAGE_CONCURRENCY = 4
const PAGE = 1000

// Credentials come from the standard AWS env vars (AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_REGION) via the SDK's default chain.
const s3 = new S3Client({})

const log = (ref: string, msg: string) => console.log(`[backup ${ref}] ${msg}`)

async function listTenants(): Promise<Tenant[]> {
  const extra = parseList(env('BACKUP_EXTRA_REFS'))
  if (!controlPlaneRef) return resolveTenants([], extra)
  const statuses = BACKUP_STATUSES.map((s) => sqlLiteral(s)).join(',')
  const rows = (await sb.runQuery(
    pat,
    controlPlaneRef,
    `select id, slug, project_ref from public.tenants where status in (${statuses}) and project_ref is not null order by created_at`,
  )) as Array<{ id: string; slug: string; project_ref: string }>
  return resolveTenants(rows, extra)
}

function run(cmd: string, args: string[], envVars: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...envVars }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(-1500)}`)),
    )
  })
}

async function pgDump(t: Tenant, host: string, readOnly: boolean, file: string): Promise<void> {
  const login = await sb.createLoginRole(pat, t.ref, readOnly)
  await run(
    'pg_dump',
    [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      ...schemas.flatMap((s) => ['--schema', s]),
      '--file',
      file,
    ],
    {
      PGHOST: host,
      PGPORT: '5432',
      PGDATABASE: 'postgres',
      PGUSER: `${login.role}.${t.ref}`,
      PGPASSWORD: login.password,
      PGSSLMODE: 'require',
      PGCONNECT_TIMEOUT: '30',
    },
  )
}

async function backupDatabase(t: Tenant, runStamp: string): Promise<{ key: string; bytes: number; role: string }> {
  const dir = await mkdtemp(join(tmpdir(), `backup-${t.ref}-`))
  const file = join(dir, 'db.dump')
  try {
    const host = await sb.poolerHost(pat, t.ref)
    // Read-only first (least privilege). pg_dump refuses to silently skip rows
    // hidden by RLS, so if that role can't see everything it errors out — then
    // fall back to the postgres-member role `supabase db dump` itself uses.
    let role = 'read_only'
    try {
      await pgDump(t, host, true, file)
    } catch (err) {
      log(t.ref, `read-only dump failed, retrying with postgres login role: ${(err as Error).message}`)
      role = 'postgres'
      await pgDump(t, host, false, file)
    }
    // A dump that pg_restore can't list is not a backup.
    await run('pg_restore', ['--list', file], {})
    const bytes = (await stat(file)).size
    const key = dumpKey(prefix, t.ref, runStamp)
    await new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: key,
        Body: createReadStream(file),
        ContentType: 'application/octet-stream',
        Metadata: { tenant: t.slug, ref: t.ref, schemas: schemas.join(','), role },
      },
    }).done()
    return { key, bytes, role }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function listStorageObjects(ref: string): Promise<StorageObject[]> {
  const out: StorageObject[] = []
  let after: [string, string] | null = null
  for (;;) {
    const where = after ? `where (bucket_id, name) > (${sqlLiteral(after[0])}, ${sqlLiteral(after[1])})` : ''
    const rows = (await sb.runQuery(
      pat,
      ref,
      `select bucket_id, name, (metadata->>'size')::bigint as size, updated_at from storage.objects ${where} order by bucket_id, name limit ${PAGE}`,
    )) as Array<{ bucket_id: string; name: string; size: number | string | null; updated_at: string | null }>
    for (const r of rows) {
      out.push({
        bucket: r.bucket_id,
        name: r.name,
        size: r.size === null ? null : Number(r.size),
        updatedAt: r.updated_at,
      })
    }
    if (rows.length < PAGE) return out
    const last = rows[rows.length - 1]
    after = [last.bucket_id, last.name]
  }
}

async function listMirror(ref: string): Promise<Map<string, MirroredObject>> {
  const out = new Map<string, MirroredObject>()
  let token: string | undefined
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: storagePrefix(prefix, ref), ContinuationToken: token }),
    )
    for (const o of page.Contents ?? []) {
      if (o.Key && o.LastModified) out.set(o.Key, { size: o.Size ?? 0, lastModified: o.LastModified })
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return out
}

async function mirrorStorage(t: Tenant): Promise<{ total: number; copied: number; failed: string[] }> {
  const [objects, mirror, keys] = await Promise.all([
    listStorageObjects(t.ref),
    listMirror(t.ref),
    sb.getApiKeys(pat, t.ref),
  ])
  const base = `https://${t.ref}.supabase.co/storage/v1/object`
  const todo = objects.filter((o) => needsCopy(o, mirror.get(storageKey(prefix, t.ref, o.bucket, o.name))))
  const failed: string[] = []
  let copied = 0
  let next = 0

  async function worker() {
    while (next < todo.length) {
      const o = todo[next++]
      const key = storageKey(prefix, t.ref, o.bucket, o.name)
      try {
        const res = await fetch(`${base}/${encodeURIComponent(o.bucket)}/${encodeObjectPath(o.name)}`, {
          headers: { Authorization: `Bearer ${keys.serviceRole}`, apikey: keys.serviceRole },
        })
        if (!res.ok || !res.body) throw new Error(`download ${res.status}`)
        await new Upload({
          client: s3,
          params: {
            Bucket: bucket,
            Key: key,
            Body: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
            ContentType: res.headers.get('content-type') ?? 'application/octet-stream',
          },
        }).done()
        copied++
      } catch (err) {
        failed.push(`${o.bucket}/${o.name}: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: STORAGE_CONCURRENCY }, worker))
  return { total: objects.length, copied, failed }
}

// Best-effort audit trail on the tenant's control-plane timeline; a failure to
// record never fails the backup itself.
async function recordEvent(t: Tenant, type: string, detail: Record<string, unknown>) {
  if (!controlPlaneRef || !t.id) return
  try {
    await sb.runQuery(
      pat,
      controlPlaneRef,
      `insert into public.cp_events (tenant_id, type, detail) values (${sqlLiteral(t.id)}, ${sqlLiteral(type)}, ${sqlLiteral(JSON.stringify(detail))}::jsonb)`,
    )
  } catch (err) {
    log(t.ref, `could not record ${type}: ${(err as Error).message}`)
  }
}

async function alert(text: string) {
  if (!alertWebhook) return
  try {
    await fetch(alertWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  } catch (err) {
    console.error(`[backup] alert webhook failed: ${(err as Error).message}`)
  }
}

interface TenantResult {
  ref: string
  slug: string
  ok: boolean
  db?: { key: string; bytes: number; role: string }
  storage?: { total: number; copied: number; failed: number }
  error?: string
}

async function backupTenant(t: Tenant, runStamp: string): Promise<TenantResult> {
  const result: TenantResult = { ref: t.ref, slug: t.slug, ok: true }
  const errors: string[] = []
  try {
    result.db = await backupDatabase(t, runStamp)
    log(t.ref, `db → s3://${bucket}/${result.db.key} (${result.db.bytes} bytes, ${result.db.role} role)`)
  } catch (err) {
    errors.push(`db: ${(err as Error).message}`)
  }
  if (!skipStorage) {
    try {
      const s = await mirrorStorage(t)
      result.storage = { total: s.total, copied: s.copied, failed: s.failed.length }
      log(t.ref, `storage: ${s.copied} copied, ${s.total - s.copied - s.failed.length} unchanged, ${s.failed.length} failed`)
      if (s.failed.length) errors.push(`storage: ${s.failed.length} object(s) failed, e.g. ${s.failed[0]}`)
    } catch (err) {
      errors.push(`storage: ${(err as Error).message}`)
    }
  }
  if (errors.length) {
    result.ok = false
    result.error = errors.join(' | ')
    log(t.ref, `FAILED ${result.error}`)
  }
  await recordEvent(t, result.ok ? 'backup.ok' : 'backup.error', { ...result })
  return result
}

async function main() {
  const started = new Date()
  const runStamp = stamp(started)
  const tenants = await listTenants()
  console.log(`[backup] ${tenants.length} project(s) → s3://${bucket}/${prefix} (schemas: ${schemas.join(', ')})`)

  // Sequential on purpose: each tenant is small, and it keeps the Management
  // API well under its rate limit and the container's disk to one dump at a time.
  const results: TenantResult[] = []
  for (const t of tenants) results.push(await backupTenant(t, runStamp))

  const failed = results.filter((r) => !r.ok)
  const summary = {
    started: started.toISOString(),
    finished: new Date().toISOString(),
    bucket,
    prefix,
    schemas,
    ok: results.length - failed.length,
    failed: failed.length,
    results,
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: runKey(prefix, runStamp),
      Body: JSON.stringify(summary, null, 2),
      ContentType: 'application/json',
    }),
  )
  console.log(`[backup] done: ${summary.ok} ok, ${summary.failed} failed`)
  if (failed.length) {
    await alert(
      `SupaNet backups: ${failed.length}/${results.length} tenant(s) FAILED\n` +
        failed.map((f) => `• ${f.slug} (${f.ref}): ${f.error}`).join('\n'),
    )
    process.exit(1)
  }
}

main().catch(async (err) => {
  console.error(`[backup] ERROR: ${(err as Error).message}`)
  await alert(`SupaNet backups: run crashed — ${(err as Error).message}`)
  process.exit(1)
})
