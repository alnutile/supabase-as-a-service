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
