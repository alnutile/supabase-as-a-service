import { dropboxMetaUrl, linkMetaUrl, runToolUrl, supabase } from './supabase'
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

/** Generate or reuse a cached TL;DR and write it to a link's description. */
export async function summarizeLink(id: string, refresh = false): Promise<boolean> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return false
  try {
    const res = await fetch(runToolUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        tool: 'summarize_resource',
        input: { source_kind: 'link', source_id: id, style: 'tldr', write_back: true, refresh },
      }),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { result?: string }
    return !!body.result && !body.result.startsWith('Could not summarize resource:')
  } catch {
    return false
  }
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
