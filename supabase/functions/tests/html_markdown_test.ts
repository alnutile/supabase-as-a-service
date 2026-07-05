// deno test — HTML → markdown conversion used by the http_request builtin.
// "Good enough for a model to read" is the bar; these pin the promises that
// matter (content survives, junk dies, budget isn't wasted on tag soup).
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { htmlToMarkdown } from '../_shared/html_markdown.ts'
import { decodeEntities } from '../_shared/linkmeta.ts'

Deno.test('drops script/style/head/comments entirely', () => {
  const out = htmlToMarkdown(
    '<head><title>t</title></head><script>evil()</script><style>.x{}</style><!-- note --><p>keep me</p>',
  )
  assertEquals(out, 'keep me')
})

Deno.test('converts headings, emphasis, and links', () => {
  const out = htmlToMarkdown('<h2>Title</h2><p><strong>bold</strong> and <em>soft</em> <a href="https://x.dev/a">go</a></p>')
  assertStringIncludes(out, '## Title')
  assertStringIncludes(out, '**bold**')
  assertStringIncludes(out, '*soft*')
  assertStringIncludes(out, '[go](https://x.dev/a)')
})

Deno.test('javascript: links keep their text but lose the href', () => {
  const out = htmlToMarkdown('<a href="javascript:alert(1)">click</a>')
  assertEquals(out, 'click')
})

Deno.test('lists become dashes; pre becomes a fenced block', () => {
  const out = htmlToMarkdown('<ul><li>one</li><li>two</li></ul><pre>x = 1</pre>')
  assertStringIncludes(out, '- one')
  assertStringIncludes(out, '- two')
  assertStringIncludes(out, '```\nx = 1\n```')
})

Deno.test('decodes entities and collapses whitespace', () => {
  const out = htmlToMarkdown('<p>a &amp; b</p>\n\n\n\n<p>c&nbsp;&#8212;&nbsp;d</p>')
  assertStringIncludes(out, 'a & b')
  assert(!out.includes('\n\n\n'), 'runs of blank lines collapse')
})

Deno.test('images surface their alt text', () => {
  assertEquals(htmlToMarkdown('<img src="x.png" alt="a chart of usage">'), '(image: a chart of usage)')
})

Deno.test('decodeEntities handles numeric and named forms', () => {
  assertEquals(decodeEntities('&#65;&#x42; &amp; &quot;q&quot; &apos;'), `AB & "q" '`)
})
