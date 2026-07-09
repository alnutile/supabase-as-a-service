// deno test — the pure `include`/`since` parsing for the MCP `get_collection`
// bundle tool. The DB assembly lives in mcp/index.ts; only the argument coercion
// is unit-testable, so that's what we pin here.
import { assertEquals } from 'jsr:@std/assert@1'
import { HUB_INCLUDES, parseIncludes, parseSince } from '../_shared/collection_hub.ts'

Deno.test('parseIncludes: missing/empty → all sections', () => {
  assertEquals(parseIncludes(undefined), [...HUB_INCLUDES])
  assertEquals(parseIncludes(null), [...HUB_INCLUDES])
  assertEquals(parseIncludes([]), [...HUB_INCLUDES])
  assertEquals(parseIncludes(''), [...HUB_INCLUDES])
})

Deno.test('parseIncludes: subset is filtered to HUB_INCLUDES order, ignoring unknowns', () => {
  assertEquals(parseIncludes(['todos', 'artifacts', 'bogus']), ['artifacts', 'todos'])
  assertEquals(parseIncludes('files, links'), ['files', 'links'])
  assertEquals(parseIncludes(['MESSAGES']), ['messages']) // case-insensitive
})

Deno.test('parseIncludes: all-unknown falls back to all (never returns empty)', () => {
  assertEquals(parseIncludes(['nope', 'zzz']), [...HUB_INCLUDES])
})

Deno.test('parseSince: absent → null', () => {
  assertEquals(parseSince(undefined), null)
  assertEquals(parseSince(null), null)
  assertEquals(parseSince(''), null)
})

Deno.test('parseSince: valid ISO is normalized', () => {
  assertEquals(parseSince('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z')
  assertEquals(parseSince('2026-01-02'), new Date('2026-01-02').toISOString())
})

Deno.test('parseSince: present-but-unparseable → "invalid"', () => {
  assertEquals(parseSince('not-a-date'), 'invalid')
  assertEquals(parseSince(12345), 'invalid')
  assertEquals(parseSince({}), 'invalid')
})
