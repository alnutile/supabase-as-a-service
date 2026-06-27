// Rough token accounting so the UI can answer "how much of the model's context
// window would this collection fill?". There is no single correct tokenizer
// across providers/models, so we use the widely-used ~4-characters-per-token
// heuristic and label every figure as an estimate (≈). It's accurate enough to
// tell whether a collection comfortably fits, is tight, or overflows — which is
// the decision the user is actually making.

const CHARS_PER_TOKEN = 4

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function estimateTokens(text: string | null | undefined): number {
  return text ? estimateTokensFromChars(text.length) : 0
}

// Compact human number: 950, 12K, 1.2M.
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export interface ModelContext {
  slug: string // the OpenRouter slug we resolved against
  name: string // friendly model name (from the catalog, else the slug)
  contextLength: number | null // total context window in tokens, or null if unknown
  found: boolean // whether we matched the slug in OpenRouter's live catalog
}

// Anthropic/others default windows, used only when the live catalog can't load
// (offline, blocked) so the meter still renders something sensible.
const FALLBACK_CONTEXT: Array<{ match: string; context: number }> = [
  { match: 'claude', context: 200_000 },
  { match: 'gpt-4o', context: 128_000 },
  { match: 'gpt-4.1', context: 1_000_000 },
  { match: 'o1', context: 200_000 },
  { match: 'gemini', context: 1_000_000 },
  { match: 'llama', context: 128_000 },
]

interface CatalogEntry {
  name: string
  context_length: number
}

// Cache the OpenRouter model catalog for the session (it changes rarely). The
// list endpoint is public + CORS-enabled, so the browser can read it directly.
let catalogPromise: Promise<Map<string, CatalogEntry>> | null = null

function loadCatalog(): Promise<Map<string, CatalogEntry>> {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const map = new Map<string, CatalogEntry>()
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models')
        const json = await res.json()
        for (const m of json?.data ?? []) {
          const ctx = Number(m?.context_length ?? m?.top_provider?.context_length ?? 0)
          map.set(String(m.id).toLowerCase(), { name: m?.name ?? m?.id, context_length: ctx })
        }
      } catch {
        // leave empty — callers fall back to FALLBACK_CONTEXT
      }
      return map
    })()
  }
  return catalogPromise
}

// Resolve a model slug (e.g. 'anthropic/claude-sonnet-4.5') to its context window.
export async function fetchModelContext(slug: string): Promise<ModelContext> {
  const s = (slug || '').toLowerCase().trim()
  const catalog = await loadCatalog()
  let hit = catalog.get(s)
  // Tolerate a bare model id with no provider prefix by matching the suffix.
  if (!hit) {
    for (const [id, entry] of catalog) {
      if (id === s || id.endsWith(`/${s}`) || (s.includes('/') && id === s.split('/').pop())) {
        hit = entry
        break
      }
    }
  }
  if (hit) {
    return { slug, name: hit.name, contextLength: hit.context_length || null, found: true }
  }
  const fb = FALLBACK_CONTEXT.find((f) => s.includes(f.match))
  return { slug, name: slug || 'model', contextLength: fb?.context ?? null, found: false }
}
