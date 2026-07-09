// Pure, side-effect-free helpers for the MCP `get_collection` bundle tool — the
// one-call collection sync that pulls artifacts/files/links/todos/tables/messages
// out of a single collection. Kept pure so the `include`/`since` argument parsing
// is unit-tested (tests/collection_hub_test.ts); the DB reads live in mcp/index.ts.

// The content sections `get_collection` can return, in the stable order used for
// output. (Kept in sync with the collection join tables the bundle reads.)
export const HUB_INCLUDES = ['artifacts', 'files', 'links', 'todos', 'tables', 'messages'] as const
export type HubInclude = (typeof HUB_INCLUDES)[number]

// Resolve the `include` argument to the ordered set of sections to build. Accepts
// an array of names or a comma-separated string. Missing / empty / all-unknown
// → every section. When some valid names are given, only those are returned, in
// HUB_INCLUDES order (so output ordering is deterministic regardless of caller order).
export function parseIncludes(v: unknown): HubInclude[] {
  const all = [...HUB_INCLUDES]
  let names: string[]
  if (Array.isArray(v)) names = v.map((x) => String(x).trim().toLowerCase())
  else if (typeof v === 'string') names = v.split(',').map((x) => x.trim().toLowerCase())
  else return all
  const want = new Set(names.filter(Boolean))
  if (!want.size) return all
  const picked = all.filter((s) => want.has(s))
  return picked.length ? picked : all
}

// Validate an optional ISO-8601 `since` filter. Returns the normalized ISO string
// when valid, null when absent, or the literal 'invalid' when present-but-unparseable
// (so the caller can reject the call instead of silently ignoring a typo'd date).
export function parseSince(v: unknown): string | null | 'invalid' {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') return 'invalid'
  const t = Date.parse(v.trim())
  if (Number.isNaN(t)) return 'invalid'
  return new Date(t).toISOString()
}
