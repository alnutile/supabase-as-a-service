import { describe, expect, it } from 'vitest'
import { absolute, cleanSubtree, htmlToMarkdown } from './markdown.js'

function el(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return doc.body
}

const md = (html, base = 'https://example.com/post') => htmlToMarkdown(el(html), base)

describe('htmlToMarkdown', () => {
  it('converts headings and paragraphs', () => {
    expect(md('<h1>Title</h1><p>Some prose.</p><h2>Part two</h2><p>More.</p>'))
      .toBe('# Title\n\nSome prose.\n\n## Part two\n\nMore.')
  })

  it('handles inline emphasis, code and strikethrough', () => {
    expect(md('<p>A <strong>bold</strong> and <em>italic</em> <code>x = 1</code> <del>gone</del> word.</p>'))
      .toBe('A **bold** and *italic* `x = 1` ~~gone~~ word.')
  })

  it('makes links and images absolute', () => {
    expect(md('<p><a href="/next">Next</a></p>')).toBe('[Next](https://example.com/next)')
    expect(md('<p><img src="../img/a.png" alt="A cat"></p>')).toBe('![A cat](https://example.com/img/a.png)')
  })

  it('drops a link with no text and neutralizes javascript: hrefs', () => {
    expect(md('<p>Hi <a href="/x"></a><a href="javascript:void(0)">click</a></p>')).toBe('Hi click')
  })

  it('prefers the first srcset candidate when there is no src', () => {
    expect(md('<p><img srcset="/a-2x.png 2x, /a.png 1x" alt=""></p>')).toBe('![](https://example.com/a-2x.png)')
  })

  it('skips inline data: images, which would bloat the artifact', () => {
    expect(md('<p><img src="data:image/png;base64,AAAA" alt="x">text</p>')).toBe('text')
  })

  it('writes nested lists with indentation', () => {
    expect(md('<ul><li>One<ul><li>One a</li></ul></li><li>Two</li></ul>'))
      .toBe('- One\n  - One a\n- Two')
  })

  it('numbers ordered lists from their start attribute', () => {
    expect(md('<ol start="3"><li>Third</li><li>Fourth</li></ol>')).toBe('3. Third\n4. Fourth')
  })

  it('fences code blocks with the detected language', () => {
    expect(md('<pre><code class="language-ts">const a = 1\n</code></pre>'))
      .toBe('```ts\nconst a = 1\n```')
  })

  it('lengthens the fence when the code itself contains backticks', () => {
    expect(md('<pre><code>a ``` b</code></pre>')).toBe('````\na ``` b\n````')
  })

  it('prefixes every line of a blockquote', () => {
    expect(md('<blockquote><p>One.</p><p>Two.</p></blockquote>')).toBe('> One.\n>\n> Two.')
  })

  it('renders a table as GFM, escaping pipes in cells', () => {
    expect(md('<table><tr><th>A</th><th>B</th></tr><tr><td>a|b</td><td>2</td></tr></table>'))
      .toBe('| A | B |\n| --- | --- |\n| a\\|b | 2 |')
  })

  it('pads a ragged table so the columns still line up', () => {
    expect(md('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>'))
      .toBe('| A | B |\n| --- | --- |\n| 1 |  |')
  })

  it('keeps a figure caption with its image', () => {
    expect(md('<figure><img src="/a.png" alt="Chart"><figcaption>Fig 1</figcaption></figure>'))
      .toBe('![Chart](https://example.com/a.png)\n\n*Fig 1*')
  })

  it('treats a div of loose prose as a paragraph', () => {
    expect(md('<div>Just words.</div><div><p>Wrapped.</p></div>')).toBe('Just words.\n\nWrapped.')
  })

  it('escapes text that would otherwise read as markup', () => {
    expect(md('<p>- not a list</p>')).toBe('\\- not a list')
    expect(md('<p>1. not ordered</p>')).toBe('1\\. not ordered')
  })

  it('collapses runaway blank lines', () => {
    expect(md('<p>A</p><div></div><div>   </div><p>B</p>')).toBe('A\n\nB')
  })
})

describe('cleanSubtree', () => {
  it('removes scripts, styles, nav and hidden nodes', () => {
    const root = el('<article><script>x()</script><nav>Home</nav><p hidden>gone</p><p>Kept.</p></article>')
    cleanSubtree(root)
    expect(htmlToMarkdown(root)).toBe('Kept.')
  })

  it('keeps an unlucky wrapper that holds most of the page, whatever its class', () => {
    const long = 'The actual article text goes here. '.repeat(60)
    const root = el(`<div><div class="content-advert-wrap"><p>${long}</p></div><div class="promo">Buy</div></div>`)
    cleanSubtree(root)
    const out = htmlToMarkdown(root)
    expect(out).toContain('The actual article text goes here.')
    expect(out).not.toContain('Buy')
  })

  it('drops an unambiguous block at any size, but an ambiguous one only when large', () => {
    const cats = 'Category listing text. '.repeat(60)
    const side = 'Sidebar body text. '.repeat(60)
    const root = el(`<div><p>Body.</p><div id="catlinks"><p>${cats}</p></div><div class="sidebar"><p>${side}</p></div></div>`)
    cleanSubtree(root)
    const out = htmlToMarkdown(root)
    expect(out).toContain('Body.')
    // "catlinks" means one thing anywhere, so it goes however big it is...
    expect(out).not.toContain('Category listing text.')
    // ...while "sidebar" is a name real articles wear, so a big one stays.
    expect(out).toContain('Sidebar body text.')
  })

  it('removes a small share widget but keeps a big block whose class merely looks junky', () => {
    const long = 'Real article sentence. '.repeat(40)
    const root = el(`<div><div class="social-share">Tweet this</div><div class="ad-content"><p>${long}</p></div></div>`)
    cleanSubtree(root)
    const out = htmlToMarkdown(root)
    expect(out).not.toContain('Tweet this')
    expect(out).toContain('Real article sentence.')
  })
})

describe('absolute', () => {
  it('resolves against the page and leaves absolute URLs alone', () => {
    expect(absolute('/a', 'https://example.com/b/c')).toBe('https://example.com/a')
    expect(absolute('https://other.com/x', 'https://example.com')).toBe('https://other.com/x')
    expect(absolute('', 'https://example.com')).toBe('')
  })

  it('returns the raw value when there is no base to resolve against', () => {
    expect(absolute('/a', '')).toBe('/a')
  })
})
