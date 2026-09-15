// DOM -> Markdown. The whole point of the "save this page as an artifact"
// mode: a modern article's HTML is tens or hundreds of KB of wrappers, and
// storing that verbatim makes an artifact nobody (and no model) wants to read.
//
// This runs in the POPUP, not in the page: the injected script only hands back
// `document.documentElement.outerHTML`, and everything below works over a
// DOMParser document. That keeps every judgment call in a module that vitest
// can exercise with jsdom instead of inside a content script.
//
// The workspace already has an HTML->markdown converter for the
// `http_request` builtin (`supabase/functions/_shared/html_markdown.ts`), but
// it works on fetched-by-the-server HTML. An extension exists precisely
// because the server cannot fetch what you are looking at - a logged-in page,
// something behind a paywall you pay for, a rendered SPA - so the conversion
// has to happen against the live DOM.

/** Elements that never carry article content. Dropped before conversion. */
const DROP = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'CANVAS', 'OBJECT', 'EMBED',
  'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'DIALOG', 'AUDIO', 'VIDEO',
  'NAV', 'ASIDE', 'FOOTER', 'HEADER',
])

// Class/id names that mark chrome rather than content, split by how sure we
// are. STRICT names have one meaning wherever they appear, so they go at any
// size; SOFT names ("content-sidebar-wrap", "ad" inside "header-ad-slot") get
// dropped only when the block is small, because sites reuse them on wrappers
// that hold the whole article.
const JUNK_STRICT = /(^|[\s_-])(share|sharing|social|comment|comments|disqus|newsletter|subscribe|signup|advert|advertisement|cookie|consent|breadcrumb|pagination|catlinks|navbox|printfooter|editsection|skip-link|screen-reader|sr-only|visually-hidden)([\s_-]|$)/i
const JUNK_SOFT = /(^|[\s_-])(promo|banner|popup|modal|sidebar|menu|nav|masthead|related|recommend|ad)([\s_-]|$)/i

const BLOCK = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'HR', 'TABLE', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD',
])

/**
 * Strip everything that is not article content from a subtree, in place.
 * Exported so extraction can clean a candidate before scoring it too.
 * @param {Element} root
 */
export function cleanSubtree(root) {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, 0x1 /* SHOW_ELEMENT */)
  const rootLength = textLength(root)
  const kill = []
  let node = walker.nextNode()
  while (node) {
    const el = /** @type {Element} */ (node)
    if (shouldDrop(el, rootLength)) kill.push(el)
    node = walker.nextNode()
  }
  for (const el of kill) el.remove()
}

function shouldDrop(el, rootLength) {
  if (DROP.has(el.tagName)) return true
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true
  const style = el.getAttribute('style') ?? ''
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true
  const label = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`.trim()
  if (!label) return false
  const own = textLength(el)
  // Whatever its name, an element holding most of the page's text IS the page.
  // Without this a single unlucky class name ("content-ad-wrap") would clip
  // the entire article away and the popup would report a thin page.
  if (rootLength && own > rootLength * 0.6) return false
  if (JUNK_STRICT.test(label)) return true
  return JUNK_SOFT.test(label) && own < 400
}

function textLength(el) {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length
}

/**
 * Convert an element's subtree to markdown.
 * @param {Element} root
 * @param {string} [baseUrl] Page URL, so relative links/images come out absolute.
 * @returns {string}
 */
export function htmlToMarkdown(root, baseUrl = '') {
  const ctx = { baseUrl }
  const md = blocks(root, ctx).join('\n\n')
  return tidy(md)
}

/** Collapse runaway blank lines and trailing spaces. */
export function tidy(md) {
  return String(md)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function blocks(el, ctx) {
  const out = []
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 /* TEXT */) {
      const t = collapse(child.nodeValue)
      if (t) out.push(escapeText(t))
      continue
    }
    if (child.nodeType !== 1) continue
    out.push(...blockFor(/** @type {Element} */ (child), ctx))
  }
  return out.filter((b) => b && b.trim())
}

function blockFor(el, ctx) {
  const tag = el.tagName
  switch (tag) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const text = inline(el, ctx).trim()
      return text ? [`${'#'.repeat(Number(tag[1]))} ${text}`] : []
    }
    case 'P': {
      const text = inline(el, ctx).trim()
      return text ? [text] : []
    }
    case 'BR':
      return []
    case 'HR':
      return ['---']
    case 'PRE':
      return [codeBlock(el)]
    case 'BLOCKQUOTE': {
      const inner = blocks(el, ctx).join('\n\n').trim()
      if (!inner) return []
      return [inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')]
    }
    case 'UL': case 'OL':
      return [list(el, ctx, 0)]
    case 'TABLE':
      return [table(el, ctx)]
    case 'FIGURE': {
      const parts = []
      const img = el.querySelector('img')
      if (img) parts.push(image(img, ctx))
      const cap = el.querySelector('figcaption')
      const capText = cap ? inline(cap, ctx).trim() : ''
      if (capText) parts.push(`*${capText}*`)
      return parts.filter(Boolean)
    }
    case 'IMG': {
      const md = image(el, ctx)
      return md ? [md] : []
    }
    case 'DL': {
      const out = []
      for (const child of Array.from(el.children)) {
        const text = inline(child, ctx).trim()
        if (!text) continue
        out.push(child.tagName === 'DT' ? `**${text}**` : text)
      }
      return out
    }
    default: {
      // A generic container: recurse when it holds blocks, otherwise treat its
      // inline content as a paragraph (countless sites wrap prose in a div).
      if (hasBlockChild(el)) return blocks(el, ctx)
      const text = inline(el, ctx).trim()
      return text ? [text] : []
    }
  }
}

function hasBlockChild(el) {
  for (const child of Array.from(el.children)) {
    if (BLOCK.has(child.tagName)) return true
  }
  return false
}

function list(el, ctx, depth) {
  const ordered = el.tagName === 'OL'
  const start = Number(el.getAttribute('start') ?? '1') || 1
  const indent = '  '.repeat(depth)
  const lines = []
  let i = 0
  for (const li of Array.from(el.children)) {
    if (li.tagName !== 'LI') continue
    const marker = ordered ? `${start + i}. ` : '- '
    const nested = []
    // Pull nested lists out so they indent under this item instead of
    // flattening into its text.
    const own = li.ownerDocument.createElement('div')
    for (const child of Array.from(li.childNodes)) {
      if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
        nested.push(list(/** @type {Element} */ (child), ctx, depth + 1))
      } else {
        own.appendChild(child.cloneNode(true))
      }
    }
    const body = hasBlockChild(own) ? blocks(own, ctx).join('\n\n') : inline(own, ctx).trim()
    const text = body.split('\n').map((l, n) => (n === 0 ? l : `${indent}  ${l}`)).join('\n')
    if (text.trim() || nested.length) lines.push(`${indent}${marker}${text.trim()}`)
    for (const n of nested) if (n.trim()) lines.push(n)
    i += 1
  }
  return lines.join('\n')
}

function codeBlock(el) {
  const code = el.querySelector('code') ?? el
  const lang = languageOf(code) || languageOf(el) || ''
  const text = (code.textContent ?? '').replace(/\n+$/, '')
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
  return `${fence}${lang}\n${text}\n${fence}`
}

function languageOf(el) {
  const cls = el.getAttribute?.('class') ?? ''
  const m = cls.match(/(?:language|lang|highlight)[-_]([a-z0-9+#]+)/i)
  return m ? m[1].toLowerCase() : ''
}

function longestBacktickRun(text) {
  let best = 0
  for (const run of String(text).match(/`+/g) ?? []) best = Math.max(best, run.length)
  return best
}

function table(el, ctx) {
  const rows = Array.from(el.querySelectorAll('tr'))
    .map((tr) => Array.from(tr.children)
      .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
      .map((c) => inline(c, ctx).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()))
    .filter((cells) => cells.length)
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r) => [...r, ...Array(width - r.length).fill('')]
  const head = pad(rows[0])
  const body = rows.slice(1).map(pad)
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
  for (const r of body) lines.push(`| ${r.join(' | ')} |`)
  return lines.join('\n')
}

function inline(el, ctx) {
  let out = ''
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      out += escapeText(collapse(child.nodeValue))
      continue
    }
    if (child.nodeType !== 1) continue
    const node = /** @type {Element} */ (child)
    switch (node.tagName) {
      case 'BR':
        out += '\n'
        break
      case 'STRONG': case 'B': {
        const t = inline(node, ctx).trim()
        out += t ? `**${t}** ` : ''
        break
      }
      case 'EM': case 'I': {
        const t = inline(node, ctx).trim()
        out += t ? `*${t}* ` : ''
        break
      }
      case 'DEL': case 'S': case 'STRIKE': {
        const t = inline(node, ctx).trim()
        out += t ? `~~${t}~~ ` : ''
        break
      }
      case 'CODE': case 'KBD': case 'SAMP': {
        const t = collapse(node.textContent)
        if (t) {
          const fence = '`'.repeat(longestBacktickRun(t) + 1)
          out += `${fence}${t}${fence}`
        }
        break
      }
      case 'A': {
        const text = inline(node, ctx).trim()
        const href = absolute(node.getAttribute('href'), ctx.baseUrl)
        if (!text) break
        out += href && !/^javascript:/i.test(href) ? `[${text}](${href})` : text
        break
      }
      case 'IMG':
        out += image(node, ctx)
        break
      default:
        out += inline(node, ctx)
    }
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n')
}

function image(el, ctx) {
  const src = absolute(
    el.getAttribute('src') || firstSrcFromSrcset(el.getAttribute('srcset')) || el.getAttribute('data-src'),
    ctx.baseUrl,
  )
  if (!src || src.startsWith('data:')) return ''
  const alt = collapse(el.getAttribute('alt') ?? '').replace(/[[\]]/g, '')
  return `![${alt}](${src})`
}

function firstSrcFromSrcset(srcset) {
  if (!srcset) return ''
  return String(srcset).split(',')[0].trim().split(/\s+/)[0] ?? ''
}

/** Resolve a possibly-relative URL against the page. Pure. */
export function absolute(href, baseUrl) {
  const raw = String(href ?? '').trim()
  if (!raw) return ''
  if (!baseUrl) return raw
  try {
    return new URL(raw, baseUrl).href
  } catch {
    return raw
  }
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ')
}

/**
 * Escape only the characters that would otherwise turn prose into markup:
 * a line that starts with a list/heading/quote marker, and stray brackets that
 * would read as a link. Deliberately light - over-escaping makes the saved
 * artifact uglier than the problem it prevents.
 */
function escapeText(text) {
  return String(text)
    .replace(/([\\`])/g, '\\$1')
    .replace(/^(\s*)([-*+>#])(\s)/gm, '$1\\$2$3')
    .replace(/^(\s*)(\d+)\.(\s)/gm, '$1$2\\.$3')
}
