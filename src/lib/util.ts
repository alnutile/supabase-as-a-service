/** A short, URL-safe random slug for public share links. */
export function makeSlug(len = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

export function formatBytes(bytes: number | null): string {
  if (!bytes && bytes !== 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

/**
 * The sentence dropped into the chat composer when a skill is picked from the
 * menu. Choosing a skill *arms* it (rather than running immediately) and
 * prefills this so the user can add context and decide when to send.
 */
export function skillInvocationSentence(name: string): string {
  return `use the skill "${name.trim()}"`
}

/** Longest chat title we persist — keeps the sidebar/header from overflowing. */
export const MAX_CHAT_TITLE = 120

/**
 * Normalize a user-typed chat title: collapse surrounding whitespace and cap
 * the length. Returns `null` when the result is empty (so callers can reject a
 * blank rename and keep the existing title).
 */
export function normalizeChatTitle(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed.slice(0, MAX_CHAT_TITLE)
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
