// deno test — the pure memory-block formatter (formatMemoriesBlock), which turns
// a user's saved memories into the system-prompt block the chat/scheduler loops
// inject. Kept pure so the DB read side of loadUserMemories doesn't need mocking.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { formatMemoriesBlock } from '../_shared/memory.ts'

const row = (over: Partial<{ id: string; content: string; key: string | null; category: string; pinned: boolean }> = {}) => ({
  id: over.id ?? crypto.randomUUID(),
  content: over.content ?? 'likes concise answers',
  key: over.key ?? null,
  category: over.category ?? 'general',
  pinned: over.pinned ?? false,
})

Deno.test('formatMemoriesBlock: empty → empty string', () => {
  assertEquals(formatMemoriesBlock([]), '')
})

Deno.test('formatMemoriesBlock: renders a heading + one bullet per memory', () => {
  const out = formatMemoriesBlock([
    row({ content: 'name is Alfred' }),
    row({ content: 'works in TypeScript' }),
  ])
  assertStringIncludes(out, '# What you remember about this user')
  assertStringIncludes(out, '- name is Alfred')
  assertStringIncludes(out, '- works in TypeScript')
})

Deno.test('formatMemoriesBlock: tags non-general category and pins', () => {
  const out = formatMemoriesBlock([row({ content: 'answer in metric', category: 'preference', pinned: true })])
  assertStringIncludes(out, '📌')
  assertStringIncludes(out, '[preference]')
  assertStringIncludes(out, 'answer in metric')
})

Deno.test('formatMemoriesBlock: a general category is NOT tagged', () => {
  const out = formatMemoriesBlock([row({ content: 'plain fact', category: 'general' })])
  assertEquals(out.includes('[general]'), false)
})

Deno.test('formatMemoriesBlock: skips blank content', () => {
  const out = formatMemoriesBlock([row({ content: '   ' }), row({ content: 'kept' })])
  assertStringIncludes(out, '- kept')
  // Only one bullet survives.
  assertEquals(out.split('\n').filter((l) => l.startsWith('- ')).length, 1)
})

Deno.test('formatMemoriesBlock: truncates to the char budget with a note', () => {
  const many = Array.from({ length: 50 }, (_, i) => row({ content: `memory number ${i} `.repeat(10) }))
  const out = formatMemoriesBlock(many, 400)
  assertStringIncludes(out, 'more memory(ies) not shown')
  // The block stays near the budget (heading + a couple bullets + the note),
  // not the full 50 memories.
  const bullets = out.split('\n').filter((l) => l.startsWith('- ')).length
  assertEquals(bullets < 50, true)
})
