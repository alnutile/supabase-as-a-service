import { describe, expect, it } from 'vitest'
import { buildArtifactBody, countWords, extractArticle, linkDensity, pickContentRoot, scoreCandidate } from './extract.js'

const PROSE = 'Row-level security is the boundary, and the policy decides what a caller may read. '

function page({ head = '', body = '' } = {}) {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
}

const ARTICLE_PAGE = page({
  head: `
    <title>RLS in practice | Example Blog</title>
    <meta property="og:site_name" content="Example Blog">
    <meta property="og:description" content="What policies actually enforce.">
    <meta name="author" content="Ada Lovelace">
  `,
  body: `
    <nav class="site-nav"><a href="/">Home</a><a href="/about">About</a><a href="/tags">Tags</a></nav>
    <div class="sidebar"><h3>Related</h3><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></div>
    <article class="post-content">
      <h1>RLS in practice</h1>
      <p>${PROSE.repeat(3)}</p>
      <p>${PROSE.repeat(3)}</p>
      <ul><li>One policy per table.</li><li>Test as an anonymous caller.</li></ul>
      <script>analytics()</script>
    </article>
    <footer>Copyright Example</footer>
  `,
})

describe('extractArticle', () => {
  const result = extractArticle(ARTICLE_PAGE, 'https://example.com/posts/rls')

  it('takes the title from og:title/h1 and strips the site suffix', () => {
    expect(result.title).toBe('RLS in practice')
  })

  it('picks up the byline, site name and excerpt', () => {
    expect(result.byline).toBe('Ada Lovelace')
    expect(result.siteName).toBe('Example Blog')
    expect(result.excerpt).toBe('What policies actually enforce.')
  })

  it('keeps the article body and drops the page furniture', () => {
    expect(result.markdown).toContain('Row-level security is the boundary')
    expect(result.markdown).toContain('- One policy per table.')
    expect(result.markdown).not.toContain('Home')
    expect(result.markdown).not.toContain('Related')
    expect(result.markdown).not.toContain('Copyright Example')
    expect(result.markdown).not.toContain('analytics()')
  })

  it('does not repeat the title as the first heading', () => {
    expect(result.markdown.startsWith('# RLS in practice')).toBe(false)
  })

  it('reports a word count and does not flag a real article as thin', () => {
    expect(result.words).toBeGreaterThan(40)
    expect(result.thin).toBe(false)
  })

  it('flags a page with almost no prose so the popup can warn', () => {
    const thin = extractArticle(page({ body: '<div id="app"></div>' }), 'https://example.com/app')
    expect(thin.thin).toBe(true)
    expect(thin.words).toBeLessThan(40)
  })

  it('falls back to the URL for a page with no title at all', () => {
    const bare = extractArticle(page({ body: '<p>hi</p>' }), 'https://example.com/x/y')
    expect(bare.title).toBe('example.com/x/y')
  })

  it('resolves relative links against a <base> tag', () => {
    const html = page({
      head: '<base href="https://cdn.example.com/v2/">',
      body: `<article><p>${PROSE}</p><p><a href="next">Next</a></p></article>`,
    })
    expect(extractArticle(html, 'https://example.com/post').markdown).toContain('https://cdn.example.com/v2/next')
  })
})

describe('pickContentRoot', () => {
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html')

  it('prefers the article over a link-heavy sidebar', () => {
    const doc = parse(ARTICLE_PAGE)
    expect(pickContentRoot(doc).className).toBe('post-content')
  })

  it('falls back to the body when nothing scores', () => {
    const doc = parse(page({ body: '<div><span>Hi</span></div>' }))
    expect(pickContentRoot(doc).tagName).toBe('BODY')
  })

  it('scores prose above a list of links of the same length', () => {
    const doc = parse(page({
      body: `
        <div id="prose"><p>${PROSE.repeat(3)}</p></div>
        <div id="links"><p>${Array.from({ length: 12 }, (_, i) => `<a href="/${i}">${PROSE.slice(0, 20)}</a>`).join(' ')}</p></div>
      `,
    }))
    const prose = doc.getElementById('prose')
    const links = doc.getElementById('links')
    expect(scoreCandidate(prose)).toBeGreaterThan(scoreCandidate(links))
  })

  it('measures link density', () => {
    const doc = parse('<body><div id="d"><a href="/a">1234567890</a>1234567890</div></body>')
    expect(linkDensity(doc.getElementById('d'))).toBeCloseTo(0.5, 5)
    expect(linkDensity(parse('<body><div id="e"></div></body>').getElementById('e'))).toBe(0)
  })
})

describe('buildArtifactBody', () => {
  const article = { markdown: '# Body\n\nText.', byline: 'Ada Lovelace', excerpt: 'A summary.' }

  it('leads with provenance so a saved page can be traced back to its source', () => {
    const body = buildArtifactBody(article, 'https://example.com/posts/rls', new Date('2026-09-15T12:00:00Z'))
    expect(body).toContain('> Saved from [example.com/posts/rls](https://example.com/posts/rls) on 2026-09-15')
    expect(body).toContain('> By Ada Lovelace')
    expect(body).toContain('> A summary.')
    expect(body).toContain('# Body')
  })

  it('omits the lines it has nothing for', () => {
    const body = buildArtifactBody({ markdown: 'Text.', byline: '', excerpt: '' }, 'https://example.com/x')
    expect(body).not.toContain('> By')
    expect(body.split('\n').filter((l) => l.startsWith('>'))).toHaveLength(1)
  })
})

describe('countWords', () => {
  it('counts on whitespace', () => {
    expect(countWords('one two  three\nfour')).toBe(4)
    expect(countWords('')).toBe(0)
  })
})
