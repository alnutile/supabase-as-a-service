import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { dropboxFallbackMetadata } from '../_shared/linkmeta.ts'

Deno.test('dropboxFallbackMetadata derives a useful title from a current file share URL', () => {
  assertEquals(
    dropboxFallbackMetadata(
      'https://www.dropbox.com/scl/fi/abc123/Quarterly%20report.pdf?rlkey=secret&dl=0',
    ),
    {
      url: 'https://www.dropbox.com/scl/fi/abc123/Quarterly%20report.pdf?rlkey=secret&dl=0',
      title: 'Quarterly report.pdf',
      description: 'Shared Dropbox PDF file',
      image_url: null,
      favicon_url: 'https://cfl.dropboxstatic.com/static/metaserver/static/images/favicon.ico',
    },
  )
})

Deno.test('dropboxFallbackMetadata recognizes current and legacy folder links', () => {
  assertEquals(
    dropboxFallbackMetadata('https://www.dropbox.com/scl/fo/abc123?rlkey=secret&dl=0')?.title,
    'Dropbox shared folder',
  )
  assertEquals(
    dropboxFallbackMetadata('https://dropbox.com/sh/abc123/token')?.description,
    'Shared Dropbox folder',
  )
})

Deno.test('dropboxFallbackMetadata recognizes legacy file links and rejects lookalike hosts', () => {
  assertEquals(
    dropboxFallbackMetadata('https://www.dropbox.com/s/abc123/photo%20one.jpg?dl=0')?.title,
    'photo one.jpg',
  )
  assertEquals(dropboxFallbackMetadata('https://dropbox.com.evil.example/s/abc123/file.pdf'), null)
  assertEquals(dropboxFallbackMetadata('https://example.com/scl/fi/abc123/file.pdf'), null)
})
