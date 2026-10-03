// Pure parsing helpers shared by the popup. Kept free of `chrome.*` and of the
// DOM so they can be unit-tested directly (extension/lib/parse.test.js).
//
// The extension deliberately speaks only to surfaces the workspace ALREADY
// exposes - the `run-tool` runner and the `artifacts` REST function - so there
// is no bespoke endpoint to keep in sync. `run-tool` hands back a tool's
// *text* result (the same string a model would see), which is why saving a
// link and listing collections need the small parsers below.

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

/**
 * Normalize whatever the user pastes into the project URL field to a bare
 * origin: `proj.supabase.co`, a trailing slash, or a full
 * `https://proj.supabase.co/functions/v1/run-tool` URL all collapse to
 * `https://proj.supabase.co`. Returns '' when there is nothing usable.
 * @param {string} input
 * @returns {string}
 */
export function normalizeBaseUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return ''
  }
  if (!url.hostname || !url.hostname.includes('.')) {
    // Allow localhost (a `supabase start` stack) but nothing else host-less.
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return ''
  }
  // Drop the functions path if they pasted a full endpoint URL.
  const path = url.pathname.replace(/\/+$/, '')
  const keep = path.replace(/\/functions\/v1(\/.*)?$/, '')
  return `${url.origin}${keep}`
}

/**
 * Parse `list_collections`' text output:
 *   `• Name (uuid) [private] — description`
 * Unparseable lines (and the "No collections yet." message) are skipped rather
 * than thrown on, so a wording change degrades to an empty picker instead of a
 * broken popup.
 * @param {string} text
 * @returns {Array<{id: string, name: string, visibility: string, description: string}>}
 */
export function parseCollectionList(text) {
  const line = new RegExp(`^\\s*[•*-]\\s*(.*?)\\s*\\((${UUID})\\)\\s*\\[([^\\]]*)\\]\\s*(?:[—-]\\s*(.*))?$`)
  const out = []
  for (const raw of String(text ?? '').split('\n')) {
    const m = raw.match(line)
    if (!m) continue
    const name = m[1].trim()
    if (!name) continue
    out.push({ id: m[2], name, visibility: m[3].trim(), description: (m[4] ?? '').trim() })
  }
  return out
}

/**
 * Parse `save_link`'s text result. Success looks like
 *   `Saved link "Title" (id uuid). Some description Filed into collection "X".`
 * Anything else is an error the tool reported in prose (a bad URL, an insert
 * failure) - surfaced verbatim rather than swallowed, since run-tool answers
 * 200 either way.
 * @param {string} text
 * @returns {{ok: true, id: string, title: string} | {ok: false, message: string}}
 */
export function parseSaveLinkResult(text) {
  const s = String(text ?? '').trim()
  const m = s.match(new RegExp(`^Saved link "(.*)" \\(id (${UUID})\\)\\.`))
  if (m) return { ok: true, id: m[2], title: m[1] }
  return { ok: false, message: s || 'The workspace returned an empty result.' }
}

/**
 * Best-effort in-app URL for something we just saved, so the popup can offer a
 * link instead of a dead end. Empty when the optional app URL is unset - the
 * Supabase project URL is NOT the app, and guessing one would produce a 404.
 */
export function appLink(appUrl, path) {
  const base = normalizeBaseUrl(appUrl)
  return base ? `${base}${path}` : ''
}

/**
 * Trim a page title down to something that reads as an artifact title:
 * "RLS in practice | Example Blog" becomes "RLS in practice".
 *
 * `siteName` may be one name or several aliases (the og:site_name AND the
 * hostname's own labels), because a site's title suffix often matches its
 * domain rather than the name it declares - Wikipedia publishes no
 * og:site_name but every title ends "- Wikipedia".
 *
 * @param {string} title
 * @param {string|string[]} siteName
 */
export function cleanTitle(title, siteName) {
  let t = String(title ?? '').replace(/\s+/g, ' ').trim()
  for (const alias of [].concat(siteName ?? []).filter(Boolean)) {
    // "Article title | Site Name" / "Article title - Site Name"
    const tail = new RegExp(`\\s*[|\\u00b7\\u2013\\u2014-]\\s*${escapeRegExp(alias)}\\s*$`, 'i')
    const stripped = t.replace(tail, '').trim()
    // Keep the suffix when removing it would leave a stub ("Docs | Example").
    if (stripped !== t && stripped.length >= 12) {
      t = stripped
      break
    }
  }
  return t.slice(0, 200)
}

/**
 * The names a site might sign its page titles with: what it declares, plus the
 * meaningful labels of its own hostname (`en.wikipedia.org` -> `wikipedia`).
 * @returns {string[]}
 */
export function siteAliases(declaredName, url) {
  const out = []
  if (declaredName) out.push(declaredName)
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  const skip = new Set(['www', 'com', 'org', 'net', 'io', 'co', 'uk', 'dev', 'app', 'blog', 'en', 'm'])
  for (const label of host.split('.')) {
    if (label.length > 2 && !skip.has(label)) out.push(label)
  }
  if (host) out.push(host)
  return [...new Set(out)]
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A short "example.com/some/path" label for the source line of a saved page. */
export function displayUrl(url) {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
    return `${u.hostname.replace(/^www\./, '')}${path}`.slice(0, 120)
  } catch {
    return String(url ?? '')
  }
}
