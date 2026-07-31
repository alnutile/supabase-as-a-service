// deno test — the pure user-table helpers (tableToText / normalizeColumns) that
// back the Tables grid's chat dock. Kept pure so no DB mocks are needed.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { normalizeColumns, tableToText } from '../_shared/user_table.ts'

Deno.test('normalizeColumns: keeps well-formed, drops keyless, defaults type/label', () => {
  const cols = normalizeColumns([
    { key: 'company', label: 'Company', type: 'text' },
    { key: 'value', type: 'number' }, // label falls back to key
    { label: 'no key' }, // dropped
    null,
    'nope',
  ])
  assertEquals(cols, [
    { key: 'company', label: 'Company', type: 'text' },
    { key: 'value', label: 'value', type: 'number' },
  ])
})

Deno.test('normalizeColumns: non-array → empty', () => {
  assertEquals(normalizeColumns(null), [])
  assertEquals(normalizeColumns({}), [])
})

Deno.test('tableToText: no fields → placeholder', () => {
  assertStringIncludes(tableToText({ name: 'X', columns: [], rows: [] }), 'no fields yet')
})

Deno.test('tableToText: fields listed with types, no rows → "No rows yet"', () => {
  const out = tableToText({
    name: 'Leads',
    columns: [
      { key: 'company', label: 'Company', type: 'text' },
      { key: 'value', label: 'Deal Value', type: 'number' },
    ],
    rows: [],
  })
  assertStringIncludes(out, 'Company (text)')
  assertStringIncludes(out, 'Deal Value (number)')
  assertStringIncludes(out, 'No rows yet')
})

Deno.test('tableToText: renders a row grid and truncates past maxRows', () => {
  const columns = [
    { key: 'company', label: 'Company', type: 'text' },
    { key: 'value', label: 'Value', type: 'number' },
  ]
  const rows = Array.from({ length: 5 }, (_, i) => ({ company: `Co ${i}`, value: i * 10 }))
  const out = tableToText({ name: 'Leads', columns, rows }, 3)
  assertStringIncludes(out, 'Company | Value')
  assertStringIncludes(out, 'Co 0 | 0')
  assertStringIncludes(out, 'Co 2 | 20')
  assertEquals(out.includes('Co 3'), false)
  assertStringIncludes(out, 'and 2 more row(s)')
})

Deno.test('tableToText: objects/booleans/null render compactly', () => {
  const out = tableToText({
    name: 'T',
    columns: [
      { key: 'a', label: 'A', type: 'json' },
      { key: 'b', label: 'B', type: 'boolean' },
      { key: 'c', label: 'C', type: 'text' },
    ],
    rows: [{ a: { x: 1 }, b: true, c: null }],
  })
  assertStringIncludes(out, '{"x":1} | true | ')
})
