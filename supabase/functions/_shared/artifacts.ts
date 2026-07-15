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
