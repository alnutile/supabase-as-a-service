// Shared executor for the Files builtins — create / list / get / delete a file
// in the workspace Files area, plus file → collection tagging. Centralized here
// (like _shared/loops.ts and _shared/knowledge.ts) so BOTH the in-app agent
// loops (via _shared/builtins.ts → runBuiltin) AND the external MCP server
// (supabase/functions/mcp) run the exact same logic and never drift.
//
// The point of these tools: the assistant can generate content it could not
// previously PERSIST — most importantly binary output like a base64 PNG from an
// image model. create_file decodes base64 (or plain text), uploads to the
// private `files` bucket under `<owner>/<uuid>/<name>` (identical to the manual
// upload path in FilesPage, so AI-created files show up in Files, obey the same
// owner-only RLS, and PDFs get auto-indexed by the enqueue_document trigger),
// registers a `files` row, and hands back a stable 7-day signed URL the user can
// click. Everything runs as the token/loop owner and is re-scoped to that owner
// in code, so an agent can only ever touch its own files.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

type DB = ReturnType<typeof createClient>

export const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB decoded — spec v1 cap.
export const SIGNED_URL_TTL = 60 * 60 * 24 * 7 // 7 days (matches the Files "share" button).

// Allowed MIME types for AI-created files (v1 — extendable). Kept deliberately
// tight so an agent can't stash arbitrary/executable blobs in Files.
export const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
])

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
}

// Infer a content-type from the filename extension when mime_type is omitted.
export function inferMime(filename: string): string | null {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  return EXT_MIME[ext] ?? null
}

// Decode a base64 string to raw bytes (handles binary content + data: URLs).
export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64
  const bin = atob(clean.trim())
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json'
}

function humanSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

async function logActivity(
  db: DB,
  type: string,
  summary: string,
  detail: Record<string, unknown>,
  actorId: string,
) {
  try {
    await db.from('activity_log').insert({ type, summary, detail, actor_id: actorId })
  } catch {
    // best-effort
  }
}

// A short-lived signed URL for a private-bucket object (absolute URL).
async function signedUrl(db: DB, path: string): Promise<string | null> {
  const { data } = await db.storage.from('files').createSignedUrl(path, SIGNED_URL_TTL)
  return data?.signedUrl ?? null
}

// Resolve a collection by id or name for this owner (own + workspace-shared);
// optionally create it (owned by `owner`, private) when missing. Mirrors the
// copies in builtins.ts / mcp so files.ts stays self-contained.
async function resolveCollection(
  db: DB,
  owner: string,
  ref: string,
  createIfMissing: boolean,
): Promise<{ id: string; name: string } | null> {
  const r = ref.trim()
  if (!r) return null
  const { data } = await db
    .from('collections')
    .select('id, name, owner_id, visibility')
    .or(`owner_id.eq.${owner},visibility.eq.workspace`)
  const found = (data ?? []).find(
    (c: { id: string; name: string }) => c.id === r || c.name.trim().toLowerCase() === r.toLowerCase(),
  )
  if (found) return { id: found.id, name: found.name }
  if (!createIfMissing) return null
  const { data: created } = await db
    .from('collections')
    .insert({ owner_id: owner, name: r, visibility: 'private' })
    .select('id, name')
    .single()
  return created ? { id: created.id, name: created.name } : null
}

type FileRow = {
  id: string
  name: string
  mime_type: string | null
  size_bytes: number | null
  visibility: string
  path: string
  bucket: string
  tags: string[] | null
  source: unknown
  created_at: string
}

// Find one of the owner's files by id (uuid) or exact filename (newest wins).
async function resolveFile(db: DB, owner: string, ref: string): Promise<FileRow | null> {
  const r = ref.trim()
  if (!r) return null
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r)
  let q = db
    .from('files')
    .select('id, name, mime_type, size_bytes, visibility, path, bucket, tags, source, created_at')
    .eq('owner_id', owner)
  q = isUuid ? q.eq('id', r) : q.eq('name', r)
  const { data } = await q.order('created_at', { ascending: false }).limit(1)
  return (data?.[0] as FileRow | undefined) ?? null
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((t) => String(t).trim()).filter(Boolean).slice(0, 32)
}

// create_file: decode base64 or text, enforce type/size limits, upload to the
// `files` bucket, register a `files` row (+ optional collection tag), return a
// signed URL. `visibility` is 'private' or 'workspace' — the `files` bucket is
// private, so both share via a 7-day signed URL; 'workspace' just flags the row
// as link-shared (stored as 'unlisted', same as the Files page share button).
export async function createFile(
  db: DB | null,
  owner: string | null,
  input: Record<string, unknown>,
): Promise<string> {
  if (!db || !owner) return 'Files are unavailable.'
  const filename = String(input?.filename ?? input?.name ?? '').trim()
  if (!filename) return 'A filename is required (e.g. "diagram.png").'

  const hasB64 = typeof input?.content_base64 === 'string' && (input.content_base64 as string).trim() !== ''
  const hasText = typeof input?.content_text === 'string' && (input.content_text as string) !== ''
  if (hasB64 === hasText) {
    return 'Provide exactly one of content_base64 or content_text.'
  }

  let mime = String(input?.mime_type ?? '').trim().toLowerCase()
  if (!mime) mime = inferMime(filename) ?? (hasText ? 'text/plain' : '')
  if (!mime) return `Could not determine the file type for "${filename}" — pass mime_type.`
  if (!ALLOWED_MIME.has(mime)) {
    return `File type "${mime}" is not allowed. Allowed: ${[...ALLOWED_MIME].join(', ')}.`
  }

  let bytes: Uint8Array
  if (hasB64) {
    try {
      bytes = decodeBase64(String(input.content_base64))
    } catch {
      return 'content_base64 is not valid base64.'
    }
  } else {
    bytes = new TextEncoder().encode(String(input.content_text))
  }
  if (bytes.length === 0) return 'The file is empty.'
  if (bytes.length > MAX_FILE_BYTES) {
    return `That file is ${humanSize(bytes.length)}; the limit is 10 MB.`
  }

  const visibility = input?.visibility === 'workspace' ? 'unlisted' : 'private'
  const tags = cleanTags(input?.tags)
  const source = input?.source && typeof input.source === 'object' ? input.source : null

  const path = `${owner}/${crypto.randomUUID()}/${filename}`
  const { error: upErr } = await db.storage
    .from('files')
    .upload(path, bytes, { contentType: mime, upsert: false })
  if (upErr) return `Upload failed: ${upErr.message}`

  const { data: row, error: rowErr } = await db
    .from('files')
    .insert({
      owner_id: owner,
      bucket: 'files',
      path,
      name: filename,
      mime_type: mime,
      size_bytes: bytes.length,
      visibility,
      tags: tags.length ? tags : null,
      source,
    })
    .select('id')
    .single()
  if (rowErr || !row) {
    await db.storage.from('files').remove([path])
    return `Saved the blob but could not register it: ${rowErr?.message ?? 'unknown error'}`
  }

  let note = ''
  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, owner, ref, true)
    if (col) {
      await db.from('collection_files').upsert(
        { collection_id: col.id, file_id: row.id, added_by: owner },
        { onConflict: 'collection_id,file_id', ignoreDuplicates: true },
      )
      note = ` Filed into collection "${col.name}".`
    }
  }

  const url = await signedUrl(db, path)
  const isPdf = mime.includes('pdf') || /\.pdf$/i.test(filename)
  await logActivity(db, 'file.created', `Created file "${filename}"`, { id: row.id, mime, size_bytes: bytes.length }, owner)
  return [
    `Created file "${filename}" (id ${row.id}).`,
    `type: ${mime}`,
    `size: ${humanSize(bytes.length)}`,
    `visibility: ${visibility === 'unlisted' ? 'workspace (link-shared)' : 'private'}`,
    url ? `url (valid 7 days): ${url}` : 'url: (could not sign — retry get_file)',
    isPdf ? 'It will be indexed into the knowledge base shortly.' : '',
    note.trim(),
  ].filter(Boolean).join('\n')
}

// list_files: the owner's files, optionally filtered by collection, tag, and
// mime prefix (e.g. "image/"). Metadata only — no bytes.
export async function listFiles(
  db: DB | null,
  owner: string | null,
  input: Record<string, unknown>,
): Promise<string> {
  if (!db || !owner) return 'Files are unavailable.'
  let limit = Number(input?.limit ?? 50)
  if (!Number.isFinite(limit) || limit <= 0) limit = 50
  limit = Math.min(Math.trunc(limit), 200)

  let query = db
    .from('files')
    .select('id, name, mime_type, size_bytes, visibility, tags, created_at')
    .eq('owner_id', owner)
    .order('created_at', { ascending: false })
    .limit(limit)

  const ref = typeof input?.collection === 'string' ? input.collection.trim() : ''
  if (ref) {
    const col = await resolveCollection(db, owner, ref, false)
    if (!col) return `Collection "${ref}" not found.`
    const { data: members } = await db.from('collection_files').select('file_id').eq('collection_id', col.id)
    const ids = (members ?? []).map((m: { file_id: string }) => m.file_id)
    if (!ids.length) return `No files in collection "${col.name}".`
    query = query.in('id', ids)
  }
  const tag = typeof input?.tag === 'string' ? input.tag.trim() : ''
  if (tag) query = query.contains('tags', [tag])
  const mimePrefix = typeof input?.mime_prefix === 'string' ? input.mime_prefix.trim() : ''
  if (mimePrefix) query = query.ilike('mime_type', `${mimePrefix}%`)

  const { data } = await query
  if (!data || !data.length) return 'No matching files.'
  return (data as Array<Pick<FileRow, 'id' | 'name' | 'mime_type' | 'size_bytes' | 'visibility' | 'tags' | 'created_at'>>)
    .map((f) => {
      const tags = f.tags && f.tags.length ? ` #${f.tags.join(' #')}` : ''
      return `• ${f.name} (${f.mime_type ?? 'unknown'}, ${humanSize(f.size_bytes ?? 0)}) [${f.visibility}]${tags}\n  id: ${f.id}`
    })
    .join('\n')
}

// get_file: metadata + a fresh 7-day signed URL by id or filename. Returns
// content_text for small text files; never inlines large binaries.
export async function getFile(
  db: DB | null,
  owner: string | null,
  input: Record<string, unknown>,
): Promise<string> {
  if (!db || !owner) return 'Files are unavailable.'
  const ref = String(input?.id ?? input?.file ?? input?.filename ?? '').trim()
  if (!ref) return 'Pass a file id or filename.'
  const f = await resolveFile(db, owner, ref)
  if (!f) return `No file matches "${ref}".`

  const url = await signedUrl(db, f.path)
  const lines = [
    `id: ${f.id}`,
    `filename: ${f.name}`,
    `type: ${f.mime_type ?? 'unknown'}`,
    `size: ${humanSize(f.size_bytes ?? 0)}`,
    `visibility: ${f.visibility}`,
    f.tags && f.tags.length ? `tags: ${f.tags.join(', ')}` : '',
    f.source ? `source: ${JSON.stringify(f.source)}` : '',
    `created_at: ${f.created_at}`,
    url ? `url (valid 7 days): ${url}` : '',
  ]
  const wantText = input?.include_text === true || input?.content_text === true
  const mime = f.mime_type ?? ''
  if (wantText && isTextMime(mime) && (f.size_bytes ?? 0) <= 200_000) {
    const { data: blob } = await db.storage.from('files').download(f.path)
    if (blob) lines.push('content_text:', await blob.text())
  }
  return lines.filter(Boolean).join('\n')
}

// delete_file: remove the storage object AND the DB row (collection_files and
// documents rows cascade off the files FK). Owner-scoped.
export async function deleteFile(
  db: DB | null,
  owner: string | null,
  input: Record<string, unknown>,
): Promise<string> {
  if (!db || !owner) return 'Files are unavailable.'
  const ref = String(input?.id ?? input?.file ?? input?.filename ?? '').trim()
  if (!ref) return 'Pass the file id (or filename) to delete.'
  const f = await resolveFile(db, owner, ref)
  if (!f) return `No file matches "${ref}".`
  await db.storage.from(f.bucket || 'files').remove([f.path])
  const { error } = await db.from('files').delete().eq('id', f.id).eq('owner_id', owner)
  if (error) return `Could not delete the file: ${error.message}`
  await logActivity(db, 'file.deleted', `Deleted file "${f.name}"`, { id: f.id }, owner)
  return `Deleted "${f.name}" (id ${f.id}).`
}

// add_file_to_collection: tag an existing file into a collection (created if
// missing), mirroring add_to_collection / add_todo_to_collection.
export async function addFileToCollection(
  db: DB | null,
  owner: string | null,
  input: Record<string, unknown>,
): Promise<string> {
  if (!db || !owner) return 'Files are unavailable.'
  const ref = String(input?.collection ?? '').trim()
  const fileRef = String(input?.file_id ?? input?.file ?? '').trim()
  if (!ref || !fileRef) return 'Pass both a collection (name or id) and a file_id.'
  const f = await resolveFile(db, owner, fileRef)
  if (!f) return `No file matches "${fileRef}".`
  const col = await resolveCollection(db, owner, ref, true)
  if (!col) return `Could not resolve collection "${ref}".`
  const { error } = await db.from('collection_files').upsert(
    { collection_id: col.id, file_id: f.id, added_by: owner },
    { onConflict: 'collection_id,file_id', ignoreDuplicates: true },
  )
  if (error) return `Could not add to the collection: ${error.message}`
  return `Added file "${f.name}" to collection "${col.name}".`
}
