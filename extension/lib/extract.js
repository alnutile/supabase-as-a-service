// Find the article inside a page and turn it into an artifact body.
//
// A readability-style scorer rather than a pile of per-site selectors: score
// every plausible container by how much *prose* it holds (paragraph text,
// sentence punctuation), penalise it for being mostly links (that is a nav or
// a "related posts" rail), and nudge on class/id names. Sites change their
// markup constantly; a heuristic degrades to "a bit more chrome than ideal",
// while a selector list degrades to "saved nothing".
import { cleanSubtree, htmlToMarkdown, tidy } from './markdown.js'
import { cleanTitle, displayUrl, siteAliases } from './parse.js'

const POSITIVE = /(^|[\s_-])(article|body|content|entry|main|page|post|story|text|blog|markdown|prose)([\s_-]|$)/i
const NEGATIVE = /(^|[\s_-])(comment|meta|footer|foot|header|masthead|nav|sidebar|widget|promo|ad|advert|banner|share|social|related|recommend|subscribe|newsletter|breadcrumb|tag|toolbar)([\s_-]|$)/i

/** Containers worth scoring. TD is in the list for old table-layout pages. */
const CANDIDATES = 'article, main, section, div, td, [role="main"]'

/**
 * @typedef {object} Extraction
 * @property {string} title
 * @property {string} byline
 * @property {string} siteName
 * @property {string} excerpt
 * @property {string} markdown  The article body, no front matter.
 * @property {number} words
 * @property {boolean} thin     True when we found very little - the caller warns.
 */

/**
 * @param {string} html  `document.documentElement.outerHTML` from the tab.
 * @param {string} pageUrl
 * @returns {Extraction}
 */
export function extractArticle(html, pageUrl) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html')
  const base = baseUrlOf(doc, pageUrl)
  const siteName = meta(doc, 'og:site_name') || meta(doc, 'application-name') || hostOf(pageUrl)
  const title = cleanTitle(
    meta(doc, 'og:title') || meta(doc, 'twitter:title') || headingTitle(doc) || doc.title || displayUrl(pageUrl),
    siteAliases(meta(doc, 'og:site_name') || meta(doc, 'application-name'), pageUrl),
  )
  const byline = meta(doc, 'author') || meta(doc, 'article:author') || bylineFromDom(doc)
  const excerpt = meta(doc, 'og:description') || meta(doc, 'description') || ''

  const root = pickContentRoot(doc)
  cleanSubtree(root)
  dropDuplicateHeading(root, title)
  const markdown = tidy(htmlToMarkdown(root, base))
  const words = countWords(markdown)

  return { title, byline, siteName, excerpt, markdown, words, thin: words < 40 }
}

/**
 * Wrap an extraction in the header the workspace's markdown renderer shows:
 * where it came from, who wrote it, when it was captured. Provenance matters
 * more here than anywhere else in the app - a compiled knowledge page or a
 * chat answer built on this artifact should be able to point back at the page.
 * @param {Extraction} article
 * @param {string} pageUrl
 * @param {Date} [now]
 */
export function buildArtifactBody(article, pageUrl, now = new Date()) {
  const captured = now.toISOString().slice(0, 10)
  const lines = [`> Saved from [${displayUrl(pageUrl)}](${pageUrl}) on ${captured}`]
  if (article.byline) lines.push(`> By ${article.byline}`)
  if (article.excerpt) lines.push('>', `> ${article.excerpt.replace(/\s+/g, ' ').trim()}`)
  return `${lines.join('\n')}\n\n---\n\n${article.markdown}\n`
}

/** Pick the element most likely to be the article. Exported for tests. */
export function pickContentRoot(doc) {
  const body = doc.body ?? doc.documentElement
  if (!body) return doc.documentElement
  let best = null
  let bestScore = 0
  for (const el of Array.from(body.querySelectorAll(CANDIDATES))) {
    const score = scoreCandidate(el)
    if (score > bestScore) {
      best = el
      bestScore = score
    }
  }
  // Nothing scored: the page is a single blob (or an app shell). Body it is.
  if (!best || bestScore < 20) return body
  return best
}

/**
 * Score one container. Exported so a regression on a real page can be pinned
 * to a number rather than to "the output looked wrong".
 */
export function scoreCandidate(el) {
  const paragraphs = Array.from(el.querySelectorAll('p, blockquote, pre, li'))
  if (!paragraphs.length) return 0
  let score = 0
  for (const p of paragraphs) {
    const text = (p.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 25) continue
    // Length, with diminishing returns, plus a nod to sentence punctuation:
    // prose has commas and full stops, a nav list does not.
    score += Math.min(60, Math.sqrt(text.length) * 3)
    score += Math.min(6, (text.match(/[,.;:]/g) ?? []).length)
  }
  const density = linkDensity(el)
  if (density > 0.5) score *= 1 - Math.min(0.9, density)
  const label = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`.trim()
  if (label) {
    if (POSITIVE.test(label)) score *= 1.25
    if (NEGATIVE.test(label)) score *= 0.4
  }
  if (el.tagName === 'ARTICLE' || el.getAttribute('role') === 'main' || el.tagName === 'MAIN') score *= 1.4
  return score
}

/** Fraction of an element's text that sits inside links. Pure. */
export function linkDensity(el) {
  const total = (el.textContent ?? '').replace(/\s+/g, ' ').trim().length
  if (!total) return 0
  let linked = 0
  for (const a of Array.from(el.querySelectorAll('a'))) {
    linked += (a.textContent ?? '').replace(/\s+/g, ' ').trim().length
  }
  return linked / total
}

export function countWords(markdown) {
  return (String(markdown).match(/\S+/g) ?? []).length
}

/** The title usually repeats as the first H1 inside the content - drop one copy. */
function dropDuplicateHeading(root, title) {
  const h = root.querySelector('h1, h2')
  if (!h) return
  const text = (h.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (text && normalize(text) === normalize(title)) h.remove()
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function meta(doc, name) {
  const sel = `meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`
  const el = doc.querySelector(sel)
  return (el?.getAttribute('content') ?? '').replace(/\s+/g, ' ').trim()
}

function headingTitle(doc) {
  const h1 = doc.querySelector('h1')
  return (h1?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function bylineFromDom(doc) {
  const el = doc.querySelector('[rel="author"], [itemprop="author"], .byline, .author, .post-author')
  const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (!text || text.length > 80) return ''
  return text.replace(/^(by|written by)\s+/i, '')
}

function baseUrlOf(doc, pageUrl) {
  const href = doc.querySelector('base[href]')?.getAttribute('href') ?? ''
  if (!href) return pageUrl
  try {
    return new URL(href, pageUrl).href
  } catch {
    return pageUrl
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
