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
