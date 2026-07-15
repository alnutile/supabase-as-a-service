// deno test — the pure artifact-filing helpers shared by the internal builtins
// and the MCP server. The DB reads/writes live in the callers; only the branching
// (id detection, collection-ref parsing, limit clamping, type normalizing) is here.
import { assertEquals } from 'jsr:@std/assert@1'
import {
  clampLimit,
  collectionRefs,
  isArtifactId,
  normalizeArtifactType,
  parseArtifactBlocks,
} from '../_shared/artifacts.ts'

Deno.test('isArtifactId: real UUIDs vs titles', () => {
  assertEquals(isArtifactId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true)
  assertEquals(isArtifactId('  3F2504E0-4F89-41D3-9A0C-0305E82C3301  '), true) // trimmed + case-insensitive
  assertEquals(isArtifactId('AI YouTube Trends 2026'), false)
  assertEquals(isArtifactId('not-a-uuid'), false)
  assertEquals(isArtifactId(''), false)
})

Deno.test('normalizeArtifactType: allow-list with markdown default', () => {
  assertEquals(normalizeArtifactType('html'), 'html')
  assertEquals(normalizeArtifactType('code'), 'code')
  assertEquals(normalizeArtifactType('text'), 'text')
  assertEquals(normalizeArtifactType('markdown'), 'markdown')
  assertEquals(normalizeArtifactType('pdf'), 'markdown') // unknown → markdown
  assertEquals(normalizeArtifactType(undefined), 'markdown')
})

Deno.test('collectionRefs: single, array, comma-string, dedupe', () => {
  assertEquals(collectionRefs({ collection: 'Blog' }), ['Blog'])
  assertEquals(collectionRefs({ collections: ['A', 'B'] }), ['A', 'B'])
  assertEquals(collectionRefs({ collections: 'A, B , C' }), ['A', 'B', 'C'])
  // single + array merge, order preserved
  assertEquals(collectionRefs({ collection: 'A', collections: ['B'] }), ['A', 'B'])
  // case-insensitive dedupe
  assertEquals(collectionRefs({ collection: 'Blog', collections: ['blog', 'News'] }), ['Blog', 'News'])
  // blanks dropped
  assertEquals(collectionRefs({ collection: '  ', collections: ['', ' X '] }), ['X'])
  // nothing
  assertEquals(collectionRefs({}), [])
  assertEquals(collectionRefs({ collections: 42 as unknown }), [])
})

Deno.test('parseArtifactBlocks: plain prose passes through', () => {
  assertEquals(parseArtifactBlocks('just a normal answer'), [
    { kind: 'text', text: 'just a normal answer' },
  ])
})

Deno.test('parseArtifactBlocks: extracts a block with surrounding prose', () => {
  const text = 'Here you go:\n:::artifact {"title":"Plan","type":"markdown"}\n# Hello\nbody\n:::\nDone.'
  assertEquals(parseArtifactBlocks(text), [
    { kind: 'text', text: 'Here you go:\n' },
    { kind: 'artifact', title: 'Plan', type: 'markdown', content: '# Hello\nbody' },
    { kind: 'text', text: '\nDone.' },
  ])
})

Deno.test('parseArtifactBlocks: unknown type falls back to markdown, title clamped', () => {
  const longTitle = 'x'.repeat(200)
  const text = `:::artifact {"title":"${longTitle}","type":"pdf"}\ncontent\n:::`
  const chunks = parseArtifactBlocks(text)
  assertEquals(chunks.length, 1)
  const art = chunks[0]
  if (art.kind !== 'artifact') throw new Error('expected an artifact chunk')
  assertEquals(art.type, 'markdown') // unknown → markdown
  assertEquals(art.title.length, 120) // clamped
})

Deno.test('parseArtifactBlocks: malformed header stays visible text', () => {
  const text = ':::artifact {not json}\ncontent\n:::'
  assertEquals(parseArtifactBlocks(text), [{ kind: 'text', text }])
})

Deno.test('parseArtifactBlocks: missing title defaults', () => {
  const chunks = parseArtifactBlocks(':::artifact {"type":"code"}\nprint(1)\n:::')
  const art = chunks[0]
  if (art.kind !== 'artifact') throw new Error('expected an artifact chunk')
  assertEquals(art.title, 'Untitled artifact')
  assertEquals(art.type, 'code')
  assertEquals(art.content, 'print(1)')
})

Deno.test('clampLimit: default, cap, and floor', () => {
  assertEquals(clampLimit(undefined, 20, 100), 20)
  assertEquals(clampLimit(5, 20, 100), 5)
  assertEquals(clampLimit(500, 20, 100), 100) // capped
  assertEquals(clampLimit(0, 20, 100), 20) // non-positive → default
  assertEquals(clampLimit(-3, 20, 100), 20)
  assertEquals(clampLimit('abc', 20, 100), 20) // non-numeric → default
  assertEquals(clampLimit(12.9, 20, 100), 12) // truncated
})
