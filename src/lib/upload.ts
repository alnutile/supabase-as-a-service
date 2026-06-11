import { supabase } from './supabase'

const BUCKET = 'files'

/**
 * Upload a user-picked file to the `files` bucket.
 *
 * Tries the File directly first — this is the original, proven path and works
 * for normal files (desktop, Dropbox/Drive, downloaded files). Only if that
 * fails (the classic mobile case where the OS hands over a virtual / cloud-backed
 * handle the browser can't stream) does it fall back to reading the bytes into
 * memory and retrying. So files that already uploaded fine are unaffected.
 *
 * Returns the stored byte size.
 */
export async function uploadPickedFile(path: string, file: File): Promise<number> {
  const direct = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type || undefined })
  if (!direct.error) return file.size

  // Direct upload failed — try materializing the bytes (virtual/cloud files).
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
  const retry = await supabase.storage
    .from(BUCKET)
    .upload(path, body, { upsert: true, contentType: file.type || 'application/octet-stream' })
  if (retry.error) throw retry.error
  return body.byteLength
}
