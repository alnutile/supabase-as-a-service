// Storage I/O for workers, with the security rules from the build handoff baked
// in: every input is re-verified to belong to the job's owner (never trust a raw
// URL), outputs go to the private `files` bucket under `<owner>/<uuid>/<name>`
// and are registered as `files` rows so they appear in the Files UI and obey RLS.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ownsResource, PermanentError, type ManifestRef, type OutputRef } from './contract.js'

// The Storage bucket outputs land in and where storage_path inputs live. Set
// once from STORAGE_BUCKET at worker startup (defaults to the app's `files`
// bucket) so nothing here hard-codes a provider or bucket name.
let outputBucket = 'files'
export function setStorageBucket(bucket: string): void {
  if (bucket) outputBucket = bucket
}

export interface ResolvedInput {
  ref: ManifestRef
  localPath: string
  filename: string
  mimeType: string | null
  ownerId: string
}

// Download one input reference to a temp file, enforcing that it belongs to the
// job owner. file_id is preferred; storage_path is accepted only when it sits
// under the owner's folder; artifact_id pulls the artifact's text content.
export async function downloadInput(
  db: SupabaseClient,
  ref: ManifestRef,
  ownerId: string,
  tmpDir: string,
): Promise<ResolvedInput> {
  if (ref.file_id) {
    const { data: file, error } = await db
      .from('files')
      .select('id, owner_id, bucket, path, name, mime_type')
      .eq('id', ref.file_id)
      .maybeSingle()
    if (error) throw new Error(`Lookup failed for file ${ref.file_id}: ${error.message}`)
    if (!file) throw new PermanentError(`Input file ${ref.file_id} not found.`)
    if (!ownsResource(ownerId, file.owner_id)) {
      throw new PermanentError(`Input file ${ref.file_id} does not belong to the job's workspace.`)
    }
    const local = await downloadObject(db, file.bucket || outputBucket, file.path, tmpDir, file.name)
    return { ref, localPath: local, filename: file.name, mimeType: file.mime_type, ownerId }
  }

  if (ref.storage_path) {
    // Only allow paths inside the owner's folder — the first path segment must be
    // the owner id (matches the storage RLS convention).
    const firstSeg = ref.storage_path.split('/')[0]
    if (firstSeg !== ownerId) {
      throw new PermanentError(`Storage path "${ref.storage_path}" is outside the job owner's folder.`)
    }
    const name = path.basename(ref.storage_path)
    const local = await downloadObject(db, outputBucket, ref.storage_path, tmpDir, name)
    return { ref, localPath: local, filename: name, mimeType: ref.mime_type ?? null, ownerId }
  }

  if (ref.artifact_id) {
    const { data: art, error } = await db
      .from('artifacts')
      .select('id, owner_id, title, content')
      .eq('id', ref.artifact_id)
      .maybeSingle()
    if (error) throw new Error(`Lookup failed for artifact ${ref.artifact_id}: ${error.message}`)
    if (!art) throw new PermanentError(`Input artifact ${ref.artifact_id} not found.`)
    if (!ownsResource(ownerId, art.owner_id)) {
      throw new PermanentError(`Input artifact ${ref.artifact_id} does not belong to the job's workspace.`)
    }
    const name = `${(art.title || 'artifact').replace(/[^\w.-]+/g, '_')}.txt`
    const local = path.join(tmpDir, `${randomUUID()}-${name}`)
    await fs.writeFile(local, String(art.content ?? ''), 'utf8')
    return { ref, localPath: local, filename: name, mimeType: 'text/plain', ownerId }
  }

  throw new PermanentError('An input reference needs a file_id, storage_path, or artifact_id.')
}

async function downloadObject(
  db: SupabaseClient,
  bucket: string,
  objectPath: string,
  tmpDir: string,
  name: string,
): Promise<string> {
  const { data, error } = await db.storage.from(bucket).download(objectPath)
  if (error || !data) throw new Error(`Download failed for ${bucket}/${objectPath}: ${error?.message ?? 'no data'}`)
  const buf = Buffer.from(await data.arrayBuffer())
  const local = path.join(tmpDir, `${randomUUID()}-${name}`)
  await fs.writeFile(local, buf)
  return local
}

// Upload a produced file to the owner's folder and register a `files` row.
// Returns the new file id for the result manifest.
export async function uploadOutput(
  db: SupabaseClient,
  ownerId: string,
  localPath: string,
  opts: { filename: string; mimeType: string; role?: string; visibility?: 'private' | 'workspace' },
): Promise<OutputRef> {
  const bytes = await fs.readFile(localPath)
  const objectPath = `${ownerId}/${randomUUID()}/${opts.filename}`
  const { error: upErr } = await db.storage
    .from(outputBucket)
    .upload(objectPath, bytes, { contentType: opts.mimeType, upsert: false })
  if (upErr) throw new Error(`Upload failed for ${opts.filename}: ${upErr.message}`)

  const visibility = opts.visibility === 'workspace' ? 'unlisted' : 'private'
  const { data: row, error: rowErr } = await db
    .from('files')
    .insert({
      owner_id: ownerId,
      bucket: outputBucket,
      path: objectPath,
      name: opts.filename,
      mime_type: opts.mimeType,
      size_bytes: bytes.length,
      visibility,
      source: { origin: 'capability_worker' },
    })
    .select('id')
    .single()
  if (rowErr || !row) {
    await db.storage.from(outputBucket).remove([objectPath])
    throw new Error(`Registered upload failed for ${opts.filename}: ${rowErr?.message ?? 'unknown'}`)
  }
  return { file_id: row.id as string, type: 'file', role: opts.role, mime_type: opts.mimeType, filename: opts.filename }
}

// Persist a text report (e.g. a validation report or a probe summary) as a
// markdown artifact and return its ref for the result manifest.
export async function uploadReportArtifact(
  db: SupabaseClient,
  ownerId: string,
  opts: { title: string; content: string; role?: string },
): Promise<OutputRef> {
  const { data: row, error } = await db
    .from('artifacts')
    .insert({ owner_id: ownerId, title: opts.title, type: 'markdown', content: opts.content, visibility: 'private' })
    .select('id')
    .single()
  if (error || !row) throw new Error(`Could not save report artifact: ${error?.message ?? 'unknown'}`)
  return { artifact_id: row.id as string, type: 'artifact', role: opts.role, mime_type: 'text/markdown' }
}

// A fresh, isolated temp dir per job (deleted after completion — see the loop).
export async function makeJobTmpDir(jobId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `job-${jobId}-${randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function cleanupTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
