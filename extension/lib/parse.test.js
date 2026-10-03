import { describe, expect, it } from 'vitest'
import { appLink, cleanTitle, displayUrl, normalizeBaseUrl, parseCollectionList, parseSaveLinkResult, siteAliases } from './parse.js'

describe('normalizeBaseUrl', () => {
  it('adds a scheme and strips trailing slashes', () => {
    expect(normalizeBaseUrl('abc.supabase.co')).toBe('https://abc.supabase.co')
    expect(normalizeBaseUrl('https://abc.supabase.co/')).toBe('https://abc.supabase.co')
  })

  it('drops a pasted functions path so the whole endpoint URL works', () => {
    expect(normalizeBaseUrl('https://abc.supabase.co/functions/v1/run-tool')).toBe('https://abc.supabase.co')
    expect(normalizeBaseUrl('https://abc.supabase.co/functions/v1')).toBe('https://abc.supabase.co')
  })

  it('keeps a local stack usable', () => {
    expect(normalizeBaseUrl('http://localhost:54321')).toBe('http://localhost:54321')
  })

  it('rejects nonsense rather than storing it', () => {
    expect(normalizeBaseUrl('')).toBe('')
    expect(normalizeBaseUrl('   ')).toBe('')
    expect(normalizeBaseUrl('not a url')).toBe('')
  })
})

describe('parseCollectionList', () => {
  const sample = [
    '• Reading (11111111-2222-3333-4444-555555555555) [private] — things to read',
    '• Team wiki (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee) [workspace]',
  ].join('\n')

  it('reads name, id, visibility and description', () => {
    expect(parseCollectionList(sample)).toEqual([
      {
        id: '11111111-2222-3333-4444-555555555555',
        name: 'Reading',
        visibility: 'private',
        description: 'things to read',
      },
      { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Team wiki', visibility: 'workspace', description: '' },
    ])
  })

  it('handles a name containing brackets and punctuation', () => {
    const line = '• Q3 (2026) planning (11111111-2222-3333-4444-555555555555) [private]'
    expect(parseCollectionList(line)[0].name).toBe('Q3 (2026) planning')
  })

  it('degrades to an empty picker instead of throwing', () => {
    expect(parseCollectionList('No collections yet. Use create_collection to make one.')).toEqual([])
    expect(parseCollectionList('')).toEqual([])
    expect(parseCollectionList(null)).toEqual([])
  })
})

describe('parseSaveLinkResult', () => {
  it('pulls the id out of a success', () => {
    const text = 'Saved link "Hello world" (id 11111111-2222-3333-4444-555555555555). A page. Filed into collection "Reading".'
    expect(parseSaveLinkResult(text)).toEqual({
      ok: true,
      id: '11111111-2222-3333-4444-555555555555',
      title: 'Hello world',
    })
  })

  it('surfaces a tool-reported failure verbatim, since run-tool still answers 200', () => {
    expect(parseSaveLinkResult('A full http(s) url is required.')).toEqual({
      ok: false,
      message: 'A full http(s) url is required.',
    })
    expect(parseSaveLinkResult('').ok).toBe(false)
  })
})

describe('cleanTitle', () => {
  it('drops a trailing site name', () => {
    expect(cleanTitle('How Postgres row-level security works | Example Blog', 'Example Blog'))
      .toBe('How Postgres row-level security works')
    expect(cleanTitle('A long enough article title - Example', 'Example')).toBe('A long enough article title')
  })

  it('keeps the title when stripping would leave a stub', () => {
    expect(cleanTitle('Docs | Example', 'Example')).toBe('Docs | Example')
  })

  it('collapses whitespace', () => {
    expect(cleanTitle('  Spaced   out \n title ', '')).toBe('Spaced out title')
  })

  it('tries every alias, so a domain-shaped suffix is stripped too', () => {
    expect(cleanTitle('PostgreSQL - Wikipedia', siteAliases('', 'https://en.wikipedia.org/wiki/PostgreSQL')))
      .toBe('PostgreSQL - Wikipedia') // stripping would leave a 10-char stub
    expect(cleanTitle('Row-level security - Wikipedia', siteAliases('', 'https://en.wikipedia.org/wiki/RLS')))
      .toBe('Row-level security')
  })
})

describe('siteAliases', () => {
  it('keeps the declared name and the meaningful hostname labels', () => {
    expect(siteAliases('Example Blog', 'https://www.example.com/x'))
      .toEqual(['Example Blog', 'example', 'www.example.com'])
  })

  it('drops language and TLD labels that never appear in a title suffix', () => {
    expect(siteAliases('', 'https://en.wikipedia.org/wiki/X')).toEqual(['wikipedia', 'en.wikipedia.org'])
  })

  it('survives a URL it cannot parse', () => {
    expect(siteAliases('Site', 'not a url')).toEqual(['Site'])
  })
})

describe('displayUrl / appLink', () => {
  it('shortens a URL for the popup header', () => {
    expect(displayUrl('https://www.example.com/posts/hello/')).toBe('example.com/posts/hello')
    expect(displayUrl('https://example.com/')).toBe('example.com')
  })

  it('only builds an app link when the workspace URL is known', () => {
    expect(appLink('https://intranet.example.com', '/links')).toBe('https://intranet.example.com/links')
    expect(appLink('', '/links')).toBe('')
  })
})
