import { describe, expect, it } from 'vitest'
import {
  imageMarkdown,
  imageUrls,
  parseStorageUrl,
  privateImagePath,
  privateImagesToPublish,
  publicImagePath,
  publicImagesToUnpublish,
  rewriteImageUrls,
  insertAtCursor,
  isImageFile,
  isUrl,
  sanitizeImageName,
  urlToMarkdown,
} from './artifactImages'

describe('isImageFile', () => {
  it('accepts by MIME type', () => {
    expect(isImageFile({ type: 'image/png' })).toBe(true)
    expect(isImageFile({ type: 'image/jpeg', name: 'photo.jpg' })).toBe(true)
    expect(isImageFile({ type: 'image/heic' })).toBe(true) // any image/*
  })
  it('accepts by extension when MIME is missing', () => {
    expect(isImageFile({ name: 'shot.PNG' })).toBe(true)
    expect(isImageFile({ name: 'diagram.svg' })).toBe(true)
  })
  it('rejects non-images', () => {
    expect(isImageFile({ type: 'application/pdf', name: 'doc.pdf' })).toBe(false)
    expect(isImageFile({ type: 'text/plain', name: 'notes.txt' })).toBe(false)
    expect(isImageFile({})).toBe(false)
  })
})

describe('sanitizeImageName', () => {
  it('keeps a clean name with a valid extension', () => {
    expect(sanitizeImageName('my-photo.png')).toBe('my-photo.png')
  })
  it('replaces unsafe characters', () => {
    expect(sanitizeImageName('CleanShot 2026-07-05 at 20.36.png')).toBe(
      'CleanShot_2026-07-05_at_20.36.png',
    )
  })
  it('adds an extension from the MIME type when missing', () => {
    expect(sanitizeImageName('screenshot', 'image/jpeg')).toBe('screenshot.jpg')
    expect(sanitizeImageName(undefined, 'image/png')).toBe('image.png')
  })
  it('handles a nameless paste', () => {
    expect(sanitizeImageName('', 'image/webp')).toBe('image.webp')
  })
})

describe('imageMarkdown', () => {
  it('builds GitHub-style image markdown', () => {
    expect(imageMarkdown('https://x/y.png')).toBe('![](https://x/y.png)')
    expect(imageMarkdown('https://x/y.png', 'a cat')).toBe('![a cat](https://x/y.png)')
  })
})

describe('insertAtCursor', () => {
  it('inserts on its own line in the middle of text', () => {
    const { text, cursor } = insertAtCursor('hello world', 5, 5, '![](u)')
    expect(text).toBe('hello\n![](u)\n world')
    expect(text.slice(0, cursor)).toBe('hello\n![](u)\n')
  })
  it('replaces a selection', () => {
    const { text } = insertAtCursor('abcXYZdef', 3, 6, '![](u)')
    expect(text).toBe('abc\n![](u)\ndef')
  })
  it('does not add a leading newline at the start', () => {
    const { text } = insertAtCursor('', 0, 0, '![](u)')
    expect(text).toBe('![](u)')
  })
  it('does not double newlines when already on a boundary', () => {
    const { text } = insertAtCursor('line1\n', 6, 6, '![](u)')
    expect(text).toBe('line1\n![](u)')
  })
  it('clamps out-of-range positions', () => {
    const { text } = insertAtCursor('abc', 99, 99, 'X')
    expect(text).toBe('abc\nX')
  })
})

describe('isUrl', () => {
  it('accepts valid HTTP(S) URLs', () => {
    expect(isUrl('https://example.com')).toBe(true)
    expect(isUrl('http://example.com')).toBe(true)
    expect(isUrl('https://example.com/path')).toBe(true)
    expect(isUrl('https://example.com/path?query=value')).toBe(true)
    expect(isUrl('https://example.com/path#anchor')).toBe(true)
    expect(isUrl('  https://example.com  ')).toBe(true) // trims whitespace
  })
  it('rejects non-URLs', () => {
    expect(isUrl('example.com')).toBe(false) // no protocol
    expect(isUrl('not a url')).toBe(false)
    expect(isUrl('https:// example.com')).toBe(false) // space in URL
    expect(isUrl('')).toBe(false)
    expect(isUrl('ftp://example.com')).toBe(false) // unsupported protocol
  })
})

describe('urlToMarkdown', () => {
  it('converts URL to markdown link syntax', () => {
    expect(urlToMarkdown('https://example.com')).toBe('[https://example.com](https://example.com)')
    expect(urlToMarkdown('http://example.com/path')).toBe('[http://example.com/path](http://example.com/path)')
  })
  it('trims whitespace from the URL', () => {
    expect(urlToMarkdown('  https://example.com  ')).toBe('[https://example.com](https://example.com)')
  })
})

describe('artifact image URL lifecycle', () => {
  const base = 'https://abc.supabase.co/storage/v1/object'
  const owner = 'u1'
  const signed = `${base}/sign/artifact-images/u1/abc/shot.png?token=xyz`
  const pub = `${base}/public/public-files/u1/artifact-images/abc/shot.png`

  it('parses signed and public storage URLs', () => {
    expect(parseStorageUrl(signed)).toEqual({ bucket: 'artifact-images', path: 'u1/abc/shot.png' })
    expect(parseStorageUrl(pub)).toEqual({ bucket: 'public-files', path: 'u1/artifact-images/abc/shot.png' })
    expect(parseStorageUrl('https://example.com/a.png')).toBeNull()
  })

  it('maps private ⇄ public paths and rejects non-image public files', () => {
    expect(publicImagePath('u1/abc/shot.png')).toBe('u1/artifact-images/abc/shot.png')
    expect(privateImagePath('u1/artifact-images/abc/shot.png')).toBe('u1/abc/shot.png')
    expect(privateImagePath('u1/abc/report.pdf')).toBeNull() // a file published from Files
  })

  it('finds markdown and html image URLs', () => {
    const md = `![a](${signed})\ntext\n<img src="${pub}" alt="b">\n[link](${signed})`
    expect(imageUrls(md)).toEqual([signed, pub])
  })

  it('only publishes the owner’s own private images, deduped', () => {
    const other = `${base}/sign/artifact-images/u2/def/x.png?token=1`
    const md = `![](${signed}) ![](${signed}) ![](${other}) ![](https://example.com/z.png)`
    expect(privateImagesToPublish(md, owner)).toEqual(['u1/abc/shot.png'])
  })

  it('only unpublishes artifact-image copies, not published Files', () => {
    const file = `${base}/public/public-files/u1/zzz/report.png`
    expect(publicImagesToUnpublish(`![](${pub}) ![](${file})`, owner)).toEqual([
      'u1/artifact-images/abc/shot.png',
    ])
  })

  it('rewrites image URLs and keeps titles and plain links intact', () => {
    const md = `![a](${signed} "cap") [l](${signed}) <img src='${signed}'>`
    const out = rewriteImageUrls(md, (u) => (u === signed ? pub : null))
    expect(out).toBe(`![a](${pub} "cap") [l](${signed}) <img src='${pub}'>`)
  })
})
