import { describe, expect, it } from 'vitest'
import { buildLinkEditPatch, isDropboxUrl, matchesLinkQuery, normalizeUrl, type SearchableLink } from './linkEdit'

describe('normalizeUrl', () => {
  it('prepends https:// to a bare domain', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/')
  })

  it('keeps an existing scheme', () => {
    expect(normalizeUrl('http://example.com/path')).toBe('http://example.com/path')
  })

  it('rejects empty and schemeless-non-hosts', () => {
    expect(normalizeUrl('   ')).toBeNull()
    expect(normalizeUrl('notaurl')).toBeNull()
  })
})

describe('isDropboxUrl', () => {
  it('recognizes Dropbox share links and subdomains', () => {
    expect(isDropboxUrl('https://www.dropbox.com/scl/fi/id/file.pdf')).toBe(true)
    expect(isDropboxUrl('https://dropbox.com/s/id/file.pdf')).toBe(true)
  })

  it('rejects invalid URLs and lookalike domains', () => {
    expect(isDropboxUrl('not a url')).toBe(false)
    expect(isDropboxUrl('https://dropbox.com.evil.example/s/id/file.pdf')).toBe(false)
  })
})

describe('buildLinkEditPatch', () => {
  it('trims text fields and normalizes the url', () => {
    const res = buildLinkEditPatch({
      url: 'example.com',
      title: '  My title  ',
      description: '  A longer description  ',
      notes: '  some notes  ',
    })
    expect(res).toEqual({
      ok: true,
      patch: {
        url: 'https://example.com/',
        title: 'My title',
        description: 'A longer description',
        notes: 'some notes',
      },
    })
  })

  it('rejects an invalid url', () => {
    const res = buildLinkEditPatch({ url: '', title: 't', description: '', notes: '' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/valid URL/i)
  })

  it('allows blank title/description/notes', () => {
    const res = buildLinkEditPatch({ url: 'https://a.com', title: '', description: '', notes: '' })
    expect(res).toEqual({
      ok: true,
      patch: { url: 'https://a.com/', title: '', description: '', notes: '' },
    })
  })
})

describe('matchesLinkQuery', () => {
  function link(partial: Partial<SearchableLink>): SearchableLink {
    return { url: 'https://example.com/', title: '', description: null, notes: null, ...partial }
  }

  it('matches an empty query against anything', () => {
    expect(matchesLinkQuery(link({ title: 'Anything' }), '')).toBe(true)
    expect(matchesLinkQuery(link({ title: 'Anything' }), '   ')).toBe(true)
  })

  it('matches the title case-insensitively', () => {
    expect(matchesLinkQuery(link({ title: 'Supabase Docs' }), 'docs')).toBe(true)
    expect(matchesLinkQuery(link({ title: 'Supabase Docs' }), 'DOCS')).toBe(true)
  })

  it('matches the url', () => {
    expect(matchesLinkQuery(link({ url: 'https://github.com/anthropics' }), 'github')).toBe(true)
  })

  it('matches the description and notes', () => {
    expect(matchesLinkQuery(link({ description: 'A realtime database' }), 'realtime')).toBe(true)
    expect(matchesLinkQuery(link({ notes: 'read this later' }), 'later')).toBe(true)
  })

  it('tolerates null description/notes', () => {
    expect(matchesLinkQuery(link({ title: 'X', description: null, notes: null }), 'missing')).toBe(false)
  })

  it('returns false when no field contains the query', () => {
    expect(matchesLinkQuery(link({ title: 'Alpha', url: 'https://a.com', description: 'beta' }), 'gamma')).toBe(false)
  })
})
