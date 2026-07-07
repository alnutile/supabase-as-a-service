import { supabase, linkMetaUrl } from './supabase'

// Pure helpers live in ./linkEdit (no side-effect imports) so they're unit-testable.
export { buildLinkEditPatch, matchesLinkQuery, normalizeUrl } from './linkEdit'
export type { LinkEditForm, LinkEditResult, SearchableLink } from './linkEdit'

export type LinkMeta = {
  url: string
  title: string
  description: string
  image_url: string | null
  favicon_url: string | null
}

/**
 * Fetch a URL's metadata (title, description, og:image, favicon) via the
 * `link-meta` edge function — the browser can't read cross-origin pages itself.
 * Returns null when signed out or the function fails; callers fall back to the
 * bare URL so adding a link never blocks on metadata.
 */
export async function fetchLinkMeta(url: string): Promise<LinkMeta | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null
  try {
    const res = await fetch(linkMetaUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ url }),
    })
    if (!res.ok) return null
    return (await res.json()) as LinkMeta
  } catch {
    return null
  }
}
