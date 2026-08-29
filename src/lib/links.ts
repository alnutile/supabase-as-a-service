import { dropboxMetaUrl, linkMetaUrl, supabase } from './supabase'
import { isDropboxUrl } from './linkEdit'

// Pure helpers live in ./linkEdit (no side-effect imports) so they're unit-testable.
export { buildLinkEditPatch, isDropboxUrl, matchesLinkQuery, normalizeUrl } from './linkEdit'
export type { LinkEditForm, LinkEditResult, SearchableLink } from './linkEdit'

export type LinkMeta = {
  url: string
  title: string
  description: string
  image_url: string | null
  favicon_url: string | null
}

/**
 * Fetch a URL's metadata (title, description, og:image, favicon). Dropbox
 * links use the configured Dropbox API integration first; if it is unavailable
 * or rejects a link, the normal HTML metadata endpoint remains the fallback.
 * Returns null when signed out or both requests fail.
 */
export async function fetchLinkMeta(url: string): Promise<LinkMeta | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null

  const endpoints = isDropboxUrl(url) ? [dropboxMetaUrl, linkMetaUrl] : [linkMetaUrl]
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) continue
      const meta = (await res.json()) as Omit<LinkMeta, 'url'> & { url?: string }
      return { ...meta, url: meta.url || url }
    } catch {
      // Try the generic endpoint after a Dropbox-specific failure.
    }
  }
  return null
}
