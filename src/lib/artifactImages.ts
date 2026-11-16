// Pure helpers for pasting/attaching images into an artifact's body (the
// GitHub-style "drop an image, get a markdown link" flow). Extracted from
// ArtifactEditorPage so the fiddly bits — filename sanitizing, markdown
// generation, cursor-aware text insertion — are unit-testable; the page owns
// the side effects (upload to storage, insert into the textarea).

// Images we accept. Mirrors the MIME allow-list used elsewhere for user
// images (create_file builtin) minus non-image types.
export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)$/i

/**
 * Is this a file we should treat as an image? Pasted screenshots come through
 * with a MIME type but often no meaningful name, so trust the type first and
 * fall back to the extension.
 */
export function isImageFile(file: { type?: string; name?: string }): boolean {
  if (file.type && IMAGE_MIME.includes(file.type)) return true
  if (file.type && file.type.startsWith('image/')) return true
  return !!file.name && IMAGE_EXT_RE.test(file.name)
}

/**
 * A storage-safe, human-ish filename. Pasted images usually arrive as
 * `image.png` or nameless; keep a sensible extension and strip anything that
 * isn't path-safe so the object key stays clean.
 */
export function sanitizeImageName(name: string | undefined, mime?: string): string {
  const fallbackExt = mime === 'image/jpeg' ? 'jpg' : (mime?.split('/')[1] ?? 'png')
  const raw = (name ?? '').trim() || `image.${fallbackExt}`
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_+/, '')
  // Ensure there's an extension so the browser serves the right content type.
  return IMAGE_EXT_RE.test(cleaned) ? cleaned : `${cleaned || 'image'}.${fallbackExt}`
}

/** GitHub-style markdown for an embedded image. */
export function imageMarkdown(url: string, alt = ''): string {
  return `![${alt}](${url})`
}

/**
 * Insert `insert` into `text`, replacing the [start,end) selection, and return
 * the new text plus where the caret should land (just after the insertion).
 * Adds surrounding newlines so an image dropped mid-paragraph lands on its own
 * line, the way a markdown block should.
 */
export function insertAtCursor(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(start, text.length))
  const e = Math.max(s, Math.min(end, text.length))
  const before = text.slice(0, s)
  const after = text.slice(e)
  const lead = before.length === 0 || before.endsWith('\n') ? '' : '\n'
  const trail = after.length === 0 || after.startsWith('\n') ? '' : '\n'
  const block = `${lead}${insert}${trail}`
  return { text: before + block + after, cursor: s + block.length }
}

// Broad URL pattern that matches http(s) URLs and common TLDs.
// Intentionally simple — false positives (detecting something that looks like a
// URL) are harmless, while false negatives (missing a valid URL) would be
// frustrating.
const URL_RE = /^https?:\/\/[^\s]+$/

/**
 * Is this text a URL? Used to detect when a pasted string should be converted
 * to a markdown link.
 */
export function isUrl(text: string): boolean {
  return URL_RE.test(text.trim())
}

/**
 * Convert a URL into a markdown link. Returns the URL wrapped in markdown link
 * syntax with the URL as both the link text and href, ready to be edited.
 */
export function urlToMarkdown(url: string): string {
  const trimmed = url.trim()
  return `[${trimmed}](${trimmed})`
}

// ---------------------------------------------------------------------------
// Image URL lifecycle: private (expiring) ⇄ public (permanent).
//
// Pasted images upload to the PRIVATE `artifact-images` bucket, and the markdown
// gets a signed URL that dies after 7 days. Two fixes hang off these helpers:
//   * Publishing an artifact (unlisted/public) copies each of its private images
//     into the public `public-files` bucket under `‹owner›/artifact-images/…` and
//     rewrites the link to that bucket's permanent public URL, so a shared page
//     keeps its images forever. Making it private again reverses that: the link
//     is pointed back at the private original and the public copy is removed.
//   * The renderer re-signs any private image link on display, so an expired
//     link (old content, or a private artifact older than a week) heals.
// The dedicated `artifact-images/` segment in the public path is what makes the
// reverse step safe: it can't be mistaken for a file published from Files.

export const ARTIFACT_IMAGE_BUCKET = 'artifact-images'
export const PUBLIC_IMAGE_BUCKET = 'public-files'
const PUBLIC_PREFIX_SEGMENT = 'artifact-images'

export type StorageRef = { bucket: string; path: string }

// Supabase storage object URL: /storage/v1/object/{sign|public|authenticated}/{bucket}/{path}[?token=…]
const STORAGE_URL_RE = /\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^/?#]+)\/([^?#]+)/

/** Pull `{bucket, path}` out of a Supabase storage URL (signed or public), else null. */
export function parseStorageUrl(url: string): StorageRef | null {
  const m = STORAGE_URL_RE.exec(url)
  if (!m) return null
  try {
    return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}

/** Public-bucket path for a private artifact image: `‹owner›/artifact-images/‹rest›`. */
export function publicImagePath(privatePath: string): string {
  const [owner, ...rest] = privatePath.split('/')
  return [owner, PUBLIC_PREFIX_SEGMENT, ...rest].join('/')
}

/** Inverse of publicImagePath; null when the path isn't an artifact-image copy. */
export function privateImagePath(publicPath: string): string | null {
  const [owner, seg, ...rest] = publicPath.split('/')
  if (!owner || seg !== PUBLIC_PREFIX_SEGMENT || rest.length === 0) return null
  return [owner, ...rest].join('/')
}

// Markdown image `![alt](url)` and HTML `<img src="url">` — the two ways a link
// to an uploaded image ends up in an artifact body.
const MD_IMAGE_RE = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g
const HTML_IMG_RE = /(<img\b[^>]*?\bsrc=["'])([^"']+)(["'])/gi

/** Every image URL in `content` (markdown + inline HTML), in document order. */
export function imageUrls(content: string): string[] {
  const out: string[] = []
  for (const m of content.matchAll(MD_IMAGE_RE)) out.push(m[2])
  for (const m of content.matchAll(HTML_IMG_RE)) out.push(m[2])
  return out
}

/** Replace image URLs in `content`: `map(url)` returns the new URL, or null to leave it. */
export function rewriteImageUrls(content: string, map: (url: string) => string | null): string {
  const swap = (_: string, pre: string, url: string, post: string) => `${pre}${map(url) ?? url}${post}`
  return content.replace(MD_IMAGE_RE, swap).replace(HTML_IMG_RE, swap)
}

/**
 * The private images an owner can publish: links into `artifact-images` under
 * the owner's own folder (storage policies only let them read their own). Deduped.
 */
export function privateImagesToPublish(content: string, ownerId: string): string[] {
  const paths = new Set<string>()
  for (const url of imageUrls(content)) {
    const ref = parseStorageUrl(url)
    if (ref?.bucket === ARTIFACT_IMAGE_BUCKET && ref.path.startsWith(`${ownerId}/`)) paths.add(ref.path)
  }
  return [...paths]
}

/** Public artifact-image copies (owner's own) linked from `content` — the ones to unpublish. Deduped. */
export function publicImagesToUnpublish(content: string, ownerId: string): string[] {
  const paths = new Set<string>()
  for (const url of imageUrls(content)) {
    const ref = parseStorageUrl(url)
    if (
      ref?.bucket === PUBLIC_IMAGE_BUCKET &&
      ref.path.startsWith(`${ownerId}/`) &&
      privateImagePath(ref.path)
    )
      paths.add(ref.path)
  }
  return [...paths]
}
