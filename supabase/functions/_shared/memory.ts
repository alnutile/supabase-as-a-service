// Pure helpers for the per-user memory feature (migration 0069).
//
// A `user_memories` row is a durable fact the assistant has learned about a
// user ("prefers concise answers", "works in the marketing team", "timezone is
// CET"). Memories are PRIVATE to their owner (owner-only RLS, like
// conversations) and injected into the chat system prompt so the assistant can
// tailor its replies across conversations.
//
// Only the branching/formatting lives here (the DB reads/writes live in the
// callers — builtins + the chat function) so it can be unit-tested without a
// database, following the repo's "extract pure logic, test the module" rule.

export type MemoryRow = { id: string; content: string; key: string | null }

/** Max characters we accept for a single memory (keeps the prompt bounded). */
export const MAX_MEMORY_CHARS = 2000
/** Default / max number of memories a list call returns. */
export const DEFAULT_MEMORY_LIMIT = 100
export const MAX_MEMORY_LIMIT = 500

/**
 * Trim + validate a memory's content. Returns the cleaned string, or null when
 * it's empty or over the length cap (the caller turns null into an error).
 */
export function sanitizeMemoryContent(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  if (s.length > MAX_MEMORY_CHARS) return null
  return s
}

/**
 * Normalize an optional memory "key" — a short stable label used to dedupe /
 * overwrite a fact (e.g. "timezone", "tone-preference"). Lowercased, spaces →
 * hyphens, only [a-z0-9-], capped at 60 chars. Returns null when absent/blank.
 */
export function normalizeMemoryKey(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || null
}

/** Clamp a requested list limit to [1, MAX] with a default. */
export function clampMemoryLimit(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN
  if (!Number.isFinite(n)) return DEFAULT_MEMORY_LIMIT
  return Math.max(1, Math.min(MAX_MEMORY_LIMIT, Math.floor(n)))
}

/**
 * Build the system-prompt block that carries the user's memories into a chat.
 * Returns '' when there's nothing to inject (so the caller appends nothing).
 * The heading doubles as an instruction so the model treats them as durable
 * facts about THIS user, not commands from an untrusted source.
 */
export function formatMemoriesForPrompt(memories: MemoryRow[]): string {
  const lines = memories
    .map((m) => (m.content ?? '').trim())
    .filter(Boolean)
    .map((c) => `- ${c}`)
  if (!lines.length) return ''
  return [
    '# What you remember about this user',
    'Durable facts you have saved about the person you are talking to. Use them to',
    'personalize your replies. If something here is clearly outdated or the user',
    'corrects it, call `update_memory` or `forget` to keep it accurate.',
    '',
    ...lines,
  ].join('\n')
}
