// deno test — the standalone artifact page's HTML assembly. The escaping here
// is load-bearing: title and saved state are user/AI-authored, and a broken
// escape would let content break out of the injected <script> tag.
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { escapeHtml, withMeta } from '../p/meta.ts'

Deno.test('escapes html-sensitive characters', () => {
  assertEquals(escapeHtml(`<b>"a" & 'b'</b>`), `&lt;b&gt;&quot;a&quot; &amp; 'b'&lt;/b&gt;`)
})

Deno.test('splices meta into an existing <head>', () => {
  const out = withMeta('<html><head><meta charset="utf-8"></head><body>x</body></html>', 'T', {})
  assertStringIncludes(out, '<head><title>T</title>')
  assertStringIncludes(out, '<meta property="og:title" content="T">')
  // No double-wrapping.
  assertEquals(out.match(/<head/g)?.length, 1)
})

Deno.test('keeps an existing <title> instead of injecting one', () => {
  const out = withMeta('<html><head><title>Mine</title></head><body>x</body></html>', 'Other', {})
  assertStringIncludes(out, '<title>Mine</title>')
  assert(!out.includes('<title>Other</title>'))
})

Deno.test('wraps bare fragments in a minimal document', () => {
  const out = withMeta('<p>hello</p>', 'Frag', {})
  assertStringIncludes(out, '<!doctype html>')
  assertStringIncludes(out, '<body><p>hello</p></body>')
})

Deno.test('injects saved state as window.__ARTIFACT_DATA__', () => {
  const out = withMeta('<p>x</p>', 'T', { done: [1] })
  assertStringIncludes(out, '<script>window.__ARTIFACT_DATA__={"done":[1]}</script>')
})

Deno.test('null/undefined state falls back to {}', () => {
  assertStringIncludes(withMeta('<p>x</p>', 'T', null), '__ARTIFACT_DATA__={}')
  assertStringIncludes(withMeta('<p>x</p>', 'T', undefined), '__ARTIFACT_DATA__={}')
})

Deno.test('a </script> inside the state cannot break out of the tag', () => {
  const out = withMeta('<p>x</p>', 'T', { note: '</script><script>alert(1)</script>' })
  assert(!out.includes('</script><script>alert(1)'), 'raw close tag must not survive')
  assertStringIncludes(out, '\\u003c/script') // escaped form is fine
})

Deno.test('escapes a hostile title in the og tags', () => {
  const out = withMeta('<p>x</p>', '"><script>alert(1)</script>', {})
  assert(!out.includes('<script>alert(1)</script>'))
})
