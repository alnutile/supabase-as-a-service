// Pure, side-effect-free helpers for the artifact authoring/filing tools, shared
// by the internal builtins (_shared/builtins.ts) and the MCP server (mcp/index.ts)
// so the two never drift. Kept pure so the branching logic is unit-tested in
// tests/artifacts_test.ts (the DB calls stay in the callers).

export const ARTIFACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isArtifactId(s: string): boolean {
  return ARTIFACT_UUID_RE.test(s.trim())
}

export const ARTIFACT_TYPES = ['markdown', 'code', 'html', 'text'] as const

export function normalizeArtifactType(v: unknown): string {
  return (ARTIFACT_TYPES as readonly string[]).includes(String(v)) ? String(v) : 'markdown'
}

// Collect collection refs (names or ids) from a `collection` (single string) and
// a `collections` (array of strings, OR a comma-separated string). Trimmed,
// de-duplicated case-insensitively, order-preserving — so create_artifact can
// file into every named collection in one call without inserting duplicates.
export function collectionRefs(input: { collection?: unknown; collections?: unknown }): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v !== 'string') return
    const t = v.trim()
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  push(input.collection)
  const cols = input.collections
  if (Array.isArray(cols)) for (const c of cols) push(c)
  else if (typeof cols === 'string') for (const c of cols.split(',')) push(c)
  return out
}

// Clamp a user-supplied limit to a sane range with a default.
export function clampLimit(v: unknown, def: number, max: number): number {
  let n = Number(v ?? def)
  if (!Number.isFinite(n) || n <= 0) n = def
  return Math.min(Math.trunc(n), max)
}

// ---------------------------------------------------------------------------
// `:::artifact {json}\n…\n:::` protocol parsing (taught by the seeded "How this
// workspace works" prompt). This mirrors the frontend parser in
// src/lib/artifacts.ts EXACTLY — the two runtimes can't share a module, so keep
// them in lockstep (both are unit-tested). The chat edge function uses this to
// materialize artifacts server-side when it persists a reply in the background,
// so an assistant that emits a block gets a saved artifact + share link whether
// the browser is still watching or not.
export type ArtifactBlockType = (typeof ARTIFACT_TYPES)[number]

export type ParsedChunk =
  // Prose to pass through untouched — including malformed blocks, which are
  // deliberately left as-is rather than half-parsed.
  | { kind: 'text'; text: string }
  | { kind: 'artifact'; title: string; type: ArtifactBlockType; content: string }

const ARTIFACT_BLOCK_RE = /:::artifact\s*(\{[\s\S]*?\})\s*\r?\n([\s\S]*?)\r?\n:::/g

export function parseArtifactBlocks(text: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  let last = 0
  let m: RegExpExecArray | null
  const re = new RegExp(ARTIFACT_BLOCK_RE) // fresh lastIndex per call
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) chunks.push({ kind: 'text', text: text.slice(last, m.index) })
    last = re.lastIndex
    let attrs: { title?: string; type?: string } = {}
    try {
      attrs = JSON.parse(m[1])
    } catch {
      // malformed header — keep the whole block as visible text
      chunks.push({ kind: 'text', text: m[0] })
      continue
    }
    chunks.push({
      kind: 'artifact',
      title: (attrs.title || 'Untitled artifact').slice(0, 120),
      type: normalizeArtifactType(attrs.type) as ArtifactBlockType,
      content: m[2].trim(),
    })
  }
  if (last < text.length) chunks.push({ kind: 'text', text: text.slice(last) })
  return chunks
}

// ---------------------------------------------------------------------------
// Public link building. The app's public share route is `/share/a/:slug` and it
// resolves by `artifacts.public_slug` — NOT the artifact id — so an agent that
// builds `/share/a/<id>` gets a 404. Every tool that returns an artifact hands
// back these ready-made URLs instead, so nothing ever has to assemble one.

// Visibilities that are reachable by a link outside the workspace. `workspace`
// is internal-only (no slug, no share link) — same rule as the editor UI.
export const LINK_SHARED_VISIBILITIES = ['unlisted', 'public'] as const

export function isLinkShared(visibility: unknown): boolean {
  return (LINK_SHARED_VISIBILITIES as readonly string[]).includes(String(visibility))
}

// The frontend origin (where `/share/a/:slug` and `/p/:slug` live). Edge
// functions can't know it, so it comes from an env var: APP_URL first, then
// SITE_URL, then the OpenRouter ranking header (which most deployments already
// set to the app origin). Trailing slashes are dropped; '' when none is set, in
// which case the URLs stay root-relative (the pre-APP_URL behavior).
export function resolveAppUrl(env: (key: string) => string | undefined): string {
  for (const key of ['APP_URL', 'SITE_URL', 'OPENROUTER_SITE_URL']) {
    const v = (env(key) ?? '').trim()
    if (/^https?:\/\//i.test(v)) return v.replace(/\/+$/, '')
  }
  return ''
}

export type ArtifactLinkRow = {
  id: string
  type?: string | null
  visibility?: string | null
  public_slug?: string | null
}

export type ArtifactUrls = {
  // The signed-in editor route (works for anyone who can see the artifact in-app).
  url: string
  // The public share page, or null when the artifact isn't link-shared.
  public_url: string | null
  // The chrome-free full-page view for html artifacts, or null.
  standalone_url: string | null
}

export function artifactUrls(row: ArtifactLinkRow, appUrl: string): ArtifactUrls {
  const base = appUrl.replace(/\/+$/, '')
  const slug = typeof row.public_slug === 'string' ? row.public_slug.trim() : ''
  const shared = !!slug && isLinkShared(row.visibility)
  const enc = encodeURIComponent(slug)
  return {
    url: `${base}/artifacts/${row.id}`,
    public_url: shared ? `${base}/share/a/${enc}` : null,
    standalone_url: shared && row.type === 'html' ? `${base}/p/${enc}` : null,
  }
}

// One-line-per-field rendering for the text tool results (get_artifact etc.).
export function artifactUrlLines(row: ArtifactLinkRow, appUrl: string): string[] {
  const u = artifactUrls(row, appUrl)
  return [
    `url: ${u.url}`,
    `visibility: ${row.visibility ?? 'private'}`,
    `public_slug: ${row.public_slug ?? 'null'}`,
    `public_url: ${u.public_url ?? 'null (not shared — use share_artifact to publish it)'}`,
    `standalone_url: ${u.standalone_url ?? 'null'}`,
  ]
}

// A short, URL-safe random slug — the same alphabet/length as the editor UI's
// makeSlug (src/lib/util.ts) and the REST artifacts function.
export function makeSlug(len = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

// The description fragment every artifact-returning tool repeats, so the model
// never falls back to assembling a share link from the id.
export const PUBLIC_LINK_GUIDANCE =
  'To link to an artifact publicly, use public_url. Never build share links from the id. If public_url is null the artifact is not shared.'
