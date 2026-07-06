import { supabase } from './supabase'

const BUCKET = 'files'

const isNetworkFailure = (err: unknown) =>
  /failed to fetch|networkerror|load failed|network request failed/i.test(
    err instanceof Error ? err.message : String(err),
  )

/**
 * Upload a user-picked file to the `files` bucket.
 *
 * Tries the File directly first — the original, proven path that works for
 * normal files (desktop, Dropbox/Drive, downloaded files). Only when that fails
 * with a network-style error (the classic mobile case where the OS hands over a
 * virtual / cloud-backed handle the browser can't stream) does it fall back to
 * reading the bytes into memory and retrying. Real errors (size, permission)
 * are surfaced as-is, and files that already uploaded fine are unaffected.
 *
 * Returns the stored byte size. Defaults to the private `files` bucket; pass a
 * different bucket (e.g. `artifact-images`) to reuse the same resilient path.
 */
export async function uploadPickedFile(path: string, file: File, bucket = BUCKET): Promise<number> {
  // 1) Direct upload (handles both thrown and returned errors).
  try {
    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, file, { upsert: false, contentType: file.type || undefined })
    if (!error) return file.size
    throw error
  } catch (err) {
    if (!isNetworkFailure(err)) throw err // a real server rejection — surface it
    // otherwise fall through to the materialize fallback
  }

  // 2) Fallback: materialize the bytes (virtual / cloud-backed mobile files).
  let body: ArrayBuffer
  try {
    body = await file.arrayBuffer()
  } catch {
    throw new Error(
      `Couldn’t read “${file.name}”. Download it to your device first (or pick it via Dropbox/Drive), then try again.`,
    )
  }
  if (body.byteLength === 0) {
    throw new Error(`“${file.name}” came through empty — download it to your device first, then try again.`)
  }
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, body, { upsert: true, contentType: file.type || 'application/octet-stream' })
  if (error) throw error
  return body.byteLength
}
