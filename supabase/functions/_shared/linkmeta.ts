// Fetch a page and extract link metadata (title, description, preview image,
// favicon) — shared by the `link-meta` edge function (the Links UI) and the
// `save_link` builtin (assistant/agents), so both fill a `links` row the same
// way. Pure fetch + regex parsing: no DB access, no secrets. Screenshots are a
// separate, later pipeline (links.screenshot_path stays null here).

export type LinkMetadata = {
  url: string
  title: string
  description: string
  image_url: string | null
  favicon_url: string | null
}

const MAX_HTML_BYTES = 512 * 1024 // metadata lives in <head>; don't stream whole pages
const FETCH_TIMEOUT_MS = 10_000

// Decode the handful of entities that commonly appear in titles/descriptions.
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

// <meta property="og:title" content="..."> in either attribute order.
function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[:._-]/g, '[:._-]')
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, 'i'),
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]) return decodeEntities(m[1])
  }
  return null
}

function absolutize(href: string | null, base: string): string | null {
  if (!href) return null
  try {
    const abs = new URL(href, base).toString()
    return /^https?:\/\//i.test(abs) ? abs : null
  } catch {
    return null
  }
}

/** Fetch `url` and parse its metadata. Never throws — falls back to the
 * hostname as the title when the page can't be read. */
export async function fetchLinkMetadata(rawUrl: string): Promise<LinkMetadata> {
  const url = rawUrl.trim()
  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    // caller validates; keep going with empty fallbacks
  }
  const fallback: LinkMetadata = { url, title: hostname || url, description: '', image_url: null, favicon_url: null }
  if (!/^https?:\/\//i.test(url)) return fallback

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Some sites serve bots an empty shell; a browsery UA gets the real head.
        'User-Agent': 'Mozilla/5.0 (compatible; IntranetLinkBot/1.0; +link-preview)',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    clearTimeout(timer)
    const finalUrl = res.url || url
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.ok || !contentType.includes('html')) {
      return { ...fallback, favicon_url: absolutize('/favicon.ico', finalUrl) }
    }

    // Read at most MAX_HTML_BYTES — enough for <head> on any sane page.
    const reader = res.body?.getReader()
    let html = ''
    if (reader) {
      const decoder = new TextDecoder()
      let bytes = 0
      while (bytes < MAX_HTML_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        html += decoder.decode(value, { stream: true })
      }
      reader.cancel().catch(() => {})
    } else {
      html = (await res.text()).slice(0, MAX_HTML_BYTES)
    }

    const rawTitle =
      metaContent(html, 'og:title') ??
      metaContent(html, 'twitter:title') ??
      decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
    const description =
      metaContent(html, 'og:description') ??
      metaContent(html, 'twitter:description') ??
      metaContent(html, 'description') ??
      ''
    const image = metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image')
    const iconHref =
      html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
      html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i)?.[1] ??
      '/favicon.ico'

    return {
      url,
      title: (rawTitle || hostname || url).slice(0, 300),
      description: description.slice(0, 1000),
      image_url: absolutize(image, finalUrl),
      favicon_url: absolutize(iconHref, finalUrl),
    }
  } catch {
    return fallback
  }
}
