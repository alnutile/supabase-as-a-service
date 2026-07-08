// deno test — the pure per-user memory helpers (migration 0069). The DB
// reads/writes live in the callers (builtins + the chat function); only the
// validation/normalization/formatting is here.
import { assertEquals } from 'jsr:@std/assert@1'
import {
  clampMemoryLimit,
  DEFAULT_MEMORY_LIMIT,
  formatMemoriesForPrompt,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_LIMIT,
  normalizeMemoryKey,
  sanitizeMemoryContent,
} from '../_shared/memory.ts'

Deno.test('sanitizeMemoryContent: trims, rejects empty and oversized', () => {
  assertEquals(sanitizeMemoryContent('  prefers concise answers  '), 'prefers concise answers')
  assertEquals(sanitizeMemoryContent(''), null)
  assertEquals(sanitizeMemoryContent('   '), null)
  assertEquals(sanitizeMemoryContent(42), null)
  assertEquals(sanitizeMemoryContent(null), null)
  assertEquals(sanitizeMemoryContent('a'.repeat(MAX_MEMORY_CHARS)), 'a'.repeat(MAX_MEMORY_CHARS))
  assertEquals(sanitizeMemoryContent('a'.repeat(MAX_MEMORY_CHARS + 1)), null)
})

Deno.test('normalizeMemoryKey: slugifies, caps, drops blanks', () => {
  assertEquals(normalizeMemoryKey('Timezone'), 'timezone')
  assertEquals(normalizeMemoryKey('  Tone Preference! '), 'tone-preference')
  assertEquals(normalizeMemoryKey('a__b  c'), 'a-b-c')
  assertEquals(normalizeMemoryKey('---'), null)
  assertEquals(normalizeMemoryKey(''), null)
  assertEquals(normalizeMemoryKey(undefined), null)
  assertEquals(normalizeMemoryKey(123), null)
  assertEquals(normalizeMemoryKey('x'.repeat(80)), 'x'.repeat(60)) // capped at 60
})

Deno.test('clampMemoryLimit: default, floor, cap, string coercion', () => {
  assertEquals(clampMemoryLimit(undefined), DEFAULT_MEMORY_LIMIT)
  assertEquals(clampMemoryLimit('nope'), DEFAULT_MEMORY_LIMIT)
  assertEquals(clampMemoryLimit(0), 1)
  assertEquals(clampMemoryLimit(-5), 1)
  assertEquals(clampMemoryLimit(10), 10)
  assertEquals(clampMemoryLimit('25'), 25)
  assertEquals(clampMemoryLimit(9999), MAX_MEMORY_LIMIT)
  assertEquals(clampMemoryLimit(3.9), 3)
})

Deno.test('formatMemoriesForPrompt: empty → no block', () => {
  assertEquals(formatMemoriesForPrompt([]), '')
  // rows with only blank content produce no block either
  assertEquals(formatMemoriesForPrompt([{ id: '1', content: '   ', key: null }]), '')
})

Deno.test('formatMemoriesForPrompt: renders a heading + bullet list', () => {
  const block = formatMemoriesForPrompt([
    { id: '1', content: 'Prefers concise answers', key: 'tone' },
    { id: '2', content: '  Timezone is CET  ', key: 'timezone' },
    { id: '3', content: '', key: null }, // skipped
  ])
  assertEquals(block.includes('# What you remember about this user'), true)
  assertEquals(block.includes('- Prefers concise answers'), true)
  assertEquals(block.includes('- Timezone is CET'), true) // trimmed
  // only two bullets survived
  assertEquals(block.split('\n').filter((l) => l.startsWith('- ')).length, 2)
})
