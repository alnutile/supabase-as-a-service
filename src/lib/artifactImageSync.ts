// Storage side of the artifact-image lifecycle (the pure URL logic lives in
// artifactImages.ts). Publishing copies an artifact's private images into the
// public bucket and rewrites the links to permanent public URLs; unpublishing
// points them back at the private originals and drops the public copies.
import { supabase } from './supabase'
import {
  ARTIFACT_IMAGE_BUCKET,
  PUBLIC_IMAGE_BUCKET,
  parseStorageUrl,
  privateImagePath,
  privateImagesToPublish,
  publicImagePath,
  publicImagesToUnpublish,
  rewriteImageUrls,
} from './artifactImages'

const SIGNED_TTL = 60 * 60 * 24 * 7

/** Copy each private image to the public bucket; return content with permanent URLs. */
export async function publishArtifactImages(content: string, ownerId: string): Promise<string> {
  const paths = privateImagesToPublish(content, ownerId)
  if (paths.length === 0) return content
  const published = new Map<string, string>()
  for (const path of paths) {
    const { data: blob, error } = await supabase.storage.from(ARTIFACT_IMAGE_BUCKET).download(path)
    if (error || !blob) continue // missing/unreadable — leave that link alone
    const dest = publicImagePath(path)
    const { error: upErr } = await supabase.storage
      .from(PUBLIC_IMAGE_BUCKET)
      .upload(dest, blob, { upsert: true, contentType: blob.type || undefined })
    if (upErr) continue
    published.set(path, supabase.storage.from(PUBLIC_IMAGE_BUCKET).getPublicUrl(dest).data.publicUrl)
  }
  return rewriteImageUrls(content, (url) => {
    const ref = parseStorageUrl(url)
    return ref?.bucket === ARTIFACT_IMAGE_BUCKET ? (published.get(ref.path) ?? null) : null
  })
}

/** Point public image copies back at the private originals and delete the copies. */
export async function unpublishArtifactImages(content: string, ownerId: string): Promise<string> {
  const paths = publicImagesToUnpublish(content, ownerId)
  if (paths.length === 0) return content
  const restored = new Map<string, string>()
  for (const pub of paths) {
    const priv = privateImagePath(pub)!
    const { data } = await supabase.storage.from(ARTIFACT_IMAGE_BUCKET).createSignedUrl(priv, SIGNED_TTL)
    // Only drop the public copy once the private original is confirmed reachable.
    if (!data?.signedUrl) continue
    restored.set(pub, data.signedUrl)
  }
  if (restored.size) await supabase.storage.from(PUBLIC_IMAGE_BUCKET).remove([...restored.keys()])
  return rewriteImageUrls(content, (url) => {
    const ref = parseStorageUrl(url)
    return ref?.bucket === PUBLIC_IMAGE_BUCKET ? (restored.get(ref.path) ?? null) : null
  })
}

// Signed URLs minted this session, so re-rendering doesn't re-sign every image.
// Entries are reused for 50 minutes of their 60-minute life.
const RESIGN_TTL = 60 * 60
const signedCache = new Map<string, { at: number; url: Promise<string | null> }>()

/**
 * A loadable URL for an image link. Private `artifact-images` links (whose baked-in
 * signature may have expired) are re-signed; returns null for anything else
 * (the caller keeps the original URL).
 */
export function resolveImageUrl(url: string): Promise<string | null> | null {
  const ref = parseStorageUrl(url)
  if (ref?.bucket !== ARTIFACT_IMAGE_BUCKET) return null
  const hit = signedCache.get(ref.path)
  if (hit && Date.now() - hit.at < (RESIGN_TTL - 600) * 1000) return hit.url
  const signed = supabase.storage
    .from(ARTIFACT_IMAGE_BUCKET)
    .createSignedUrl(ref.path, RESIGN_TTL)
    .then(({ data }) => data?.signedUrl ?? null)
  signedCache.set(ref.path, { at: Date.now(), url: signed })
  return signed
}
