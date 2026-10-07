// deno test — public artifact URLs handed back by the MCP server / builtins.
// The share route resolves by public_slug, never the id, so these guard against
// an agent ever being given (or able to assemble) `/share/a/<id>`.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { artifactUrlLines, artifactUrls, isLinkShared, makeSlug, resolveAppUrl } from '../_shared/artifacts.ts'

const APP = 'https://app.example.com'
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

Deno.test('private artifact: public_url and standalone_url are null', () => {
  const u = artifactUrls({ id: ID, type: 'html', visibility: 'private', public_slug: null }, APP)
  assertEquals(u.public_url, null)
  assertEquals(u.standalone_url, null)
  assertEquals(u.url, `${APP}/artifacts/${ID}`)
})

Deno.test('private artifact with a leftover slug is still not shared', () => {
  // Flipping back to private keeps the slug; the link must not be handed out.
  const u = artifactUrls({ id: ID, type: 'html', visibility: 'private', public_slug: 'abc123xyz0' }, APP)
  assertEquals(u.public_url, null)
  assertEquals(u.standalone_url, null)
})

Deno.test('workspace visibility is internal-only — no public link', () => {
  const u = artifactUrls({ id: ID, type: 'markdown', visibility: 'workspace', public_slug: 'abc123xyz0' }, APP)
  assertEquals(u.public_url, null)
})

Deno.test('shared artifact: /share/a/<slug>', () => {
  const unlisted = artifactUrls({ id: ID, type: 'markdown', visibility: 'unlisted', public_slug: 'k3j9x0p2qa' }, APP)
  assertEquals(unlisted.public_url, `${APP}/share/a/k3j9x0p2qa`)
  assertEquals(unlisted.standalone_url, null) // markdown has no standalone page
  const pub = artifactUrls({ id: ID, type: 'html', visibility: 'public', public_slug: 'k3j9x0p2qa' }, APP)
  assertEquals(pub.public_url, `${APP}/share/a/k3j9x0p2qa`)
  assertEquals(pub.standalone_url, `${APP}/p/k3j9x0p2qa`)
})

Deno.test('shared but slug missing → null, never a fallback to the id', () => {
  const u = artifactUrls({ id: ID, type: 'html', visibility: 'public', public_slug: null }, APP)
  assertEquals(u.public_url, null)
  assertEquals(u.standalone_url, null)
})

Deno.test('public URLs never contain the artifact id', () => {
  for (const visibility of ['private', 'workspace', 'unlisted', 'public']) {
    for (const type of ['markdown', 'html', 'code', 'text']) {
      for (const public_slug of [null, '', 'k3j9x0p2qa']) {
        const u = artifactUrls({ id: ID, type, visibility, public_slug }, APP)
        for (const v of [u.public_url, u.standalone_url]) {
          if (v !== null) assert(!v.includes(ID), `${v} leaks the id`)
        }
      }
    }
  }
  const lines = artifactUrlLines({ id: ID, type: 'html', visibility: 'public', public_slug: 'k3j9x0p2qa' }, APP)
  for (const l of lines.filter((l) => l.startsWith('public_url') || l.startsWith('standalone_url'))) {
    assert(!l.includes(ID))
  }
})

Deno.test('text rendering shows null when not shared', () => {
  const lines = artifactUrlLines({ id: ID, type: 'markdown', visibility: 'private', public_slug: null }, APP)
  assertEquals(lines[0], `url: ${APP}/artifacts/${ID}`)
  assert(lines.some((l) => l.startsWith('public_url: null')))
})

Deno.test('resolveAppUrl: APP_URL > SITE_URL > OPENROUTER_SITE_URL, trailing slash dropped', () => {
  const env = (m: Record<string, string>) => (k: string) => m[k]
  assertEquals(resolveAppUrl(env({ APP_URL: 'https://a.example/', SITE_URL: 'https://b.example' })), 'https://a.example')
  assertEquals(resolveAppUrl(env({ SITE_URL: 'https://b.example//' })), 'https://b.example')
  assertEquals(resolveAppUrl(env({ OPENROUTER_SITE_URL: 'https://c.example' })), 'https://c.example')
  assertEquals(resolveAppUrl(env({ APP_URL: 'not a url', SITE_URL: 'https://b.example' })), 'https://b.example')
  assertEquals(resolveAppUrl(env({})), '')
})

Deno.test('no app origin configured → root-relative paths (old behavior)', () => {
  const u = artifactUrls({ id: ID, type: 'html', visibility: 'unlisted', public_slug: 'k3j9x0p2qa' }, '')
  assertEquals(u.url, `/artifacts/${ID}`)
  assertEquals(u.public_url, '/share/a/k3j9x0p2qa')
  assertEquals(u.standalone_url, '/p/k3j9x0p2qa')
})

Deno.test('isLinkShared + makeSlug', () => {
  assertEquals(isLinkShared('unlisted'), true)
  assertEquals(isLinkShared('public'), true)
  assertEquals(isLinkShared('workspace'), false)
  assertEquals(isLinkShared('private'), false)
  const s = makeSlug()
  assertEquals(s.length, 10)
  assert(/^[a-z0-9]+$/.test(s))
})
