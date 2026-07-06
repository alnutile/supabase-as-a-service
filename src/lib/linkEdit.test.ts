import { describe, expect, it } from 'vitest'
import { buildLinkEditPatch, normalizeUrl } from './linkEdit'

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
