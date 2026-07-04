import { supabase, linkMetaUrl } from './supabase'

export type LinkMeta = {
  url: string
  title: string
  description: string
  image_url: string | null
  favicon_url: string | null
}

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
