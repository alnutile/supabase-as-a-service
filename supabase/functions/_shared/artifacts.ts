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
