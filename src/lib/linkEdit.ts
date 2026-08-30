// Pure link helpers — no Supabase/side-effect imports so they can be unit-tested
// in isolation (the network-touching helpers live in links.ts).

/** Prepend https:// when the user pastes a bare domain ("example.com"). */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  try {
    const u = new URL(withScheme)
    return u.hostname.includes('.') || u.hostname === 'localhost' ? u.toString() : null
  } catch {
    return null
  }
}

/** True only for Dropbox itself or one of its subdomains. Avoid a loose
 * `includes('dropbox.com')` check, which would accept lookalike hosts. */
export function isDropboxUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase()
    return hostname === 'dropbox.com' || hostname.endsWith('.dropbox.com')
  } catch {
    return false
  }
}

// The subset of a link the quick search reads — the `links` row satisfies it,
// and keeping it minimal makes the helper trivial to test with plain objects.
export type SearchableLink = {
  url: string
  title: string
  description: string | null
  notes: string | null
}

// Case-insensitive substring match against the title, URL, description and
// notes — the quick search on the Links page (complements the global ⌘K search,
// mirrors matchesTodoQuery on To-dos).
export function matchesLinkQuery(link: SearchableLink, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [link.title, link.url, link.description, link.notes].some((f) => (f ?? '').toLowerCase().includes(q))
}

export type LinkEditForm = {
  url: string
  title: string
  description: string
  notes: string
}

export type LinkEditResult =
  | { ok: true; patch: { url: string; title: string; description: string; notes: string } }
  | { ok: false; error: string }

/**
 * Validate + normalize a link edit form into a DB patch. The URL is required
 * and normalized (bare domains get an https:// scheme); the text fields are
 * trimmed. Keeps the "Edit a link" modal's logic out of the component so it can
 * be unit-tested.
 */
export function buildLinkEditPatch(form: LinkEditForm): LinkEditResult {
  const url = normalizeUrl(form.url)
  if (!url) return { ok: false, error: 'Enter a valid URL.' }
  return {
    ok: true,
    patch: {
      url,
      title: form.title.trim(),
      description: form.description.trim(),
      notes: form.notes.trim(),
    },
  }
}
