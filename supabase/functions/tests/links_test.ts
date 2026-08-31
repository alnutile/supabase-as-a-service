import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { dateColumn, formatLinkList, isoSeconds, parseDateBound, timestampLine } from '../_shared/links.ts'

Deno.test('isoSeconds trims a Postgres timestamptz to whole seconds', () => {
  assertEquals(isoSeconds('2026-08-31T14:03:22.123456+00:00'), '2026-08-31T14:03:22Z')
  assertEquals(isoSeconds('2026-08-31T10:03:22.5-04:00'), '2026-08-31T14:03:22Z')
})

Deno.test('isoSeconds is empty for a missing or unparseable value', () => {
  assertEquals(isoSeconds(null), '')
  assertEquals(isoSeconds(undefined), '')
  assertEquals(isoSeconds(''), '')
  assertEquals(isoSeconds('not a date'), '')
})

Deno.test('timestampLine hides updated when the link has never been edited', () => {
  assertEquals(
    timestampLine({
      id: 'a',
      url: 'https://example.com',
      title: 'Example',
      description: '',
      created_at: '2026-08-31T14:03:22.123456+00:00',
      updated_at: '2026-08-31T14:03:22.123456+00:00',
    }),
    'saved: 2026-08-31T14:03:22Z',
  )
})

Deno.test('timestampLine shows both dates once the link has been edited', () => {
  assertEquals(
    timestampLine({
      id: 'a',
      url: 'https://example.com',
      title: 'Example',
      description: '',
      created_at: '2026-08-01T09:00:00+00:00',
      updated_at: '2026-08-31T14:03:22+00:00',
    }),
    'saved: 2026-08-01T09:00:00Z · updated: 2026-08-31T14:03:22Z',
  )
})

Deno.test('timestampLine degrades to nothing when a row carries no dates', () => {
  assertEquals(timestampLine({ id: 'a', url: 'u', title: 't', description: '' }), '')
})

Deno.test('formatLinkList renders title, url, description, id and dates', () => {
  const out = formatLinkList([
    {
      id: 'id-1',
      url: 'https://example.com/post',
      title: 'A post',
      description: 'What it is about',
      created_at: '2026-08-01T09:00:00+00:00',
      updated_at: '2026-08-31T14:03:22+00:00',
    },
  ])
  assertEquals(
    out,
    '• A post — https://example.com/post\n  What it is about\n  id: id-1 · saved: 2026-08-01T09:00:00Z · updated: 2026-08-31T14:03:22Z',
  )
})

Deno.test('formatLinkList truncates a long description and keeps the id line intact', () => {
  const out = formatLinkList([
    {
      id: 'id-2',
      url: 'https://example.com',
      title: 'Long',
      description: 'x'.repeat(400),
      created_at: '2026-08-01T09:00:00+00:00',
      updated_at: '2026-08-01T09:00:00+00:00',
    },
  ])
  assert(out.includes(`  ${'x'.repeat(200)}\n`))
  assert(!out.includes('x'.repeat(201)))
  assert(out.endsWith('id: id-2 · saved: 2026-08-01T09:00:00Z'))
})

Deno.test('formatLinkList puts one bullet per link', () => {
  const out = formatLinkList([
    { id: '1', url: 'https://a.test', title: 'A', description: '' },
    { id: '2', url: 'https://b.test', title: 'B', description: '' },
  ])
  assertEquals(out, '• A — https://a.test\n  id: 1\n• B — https://b.test\n  id: 2')
})

Deno.test('parseDateBound passes an ISO timestamp through, normalized to UTC', () => {
  assertEquals(parseDateBound('2026-08-31T14:03:22+00:00', 'start'), '2026-08-31T14:03:22.000Z')
  assertEquals(parseDateBound('2026-08-31T10:03:22-04:00', 'end'), '2026-08-31T14:03:22.000Z')
})

Deno.test('parseDateBound widens a bare date to the whole UTC day', () => {
  assertEquals(parseDateBound('2026-08-31', 'start'), '2026-08-31T00:00:00.000Z')
  assertEquals(parseDateBound('2026-08-31', 'end'), '2026-08-31T23:59:59.999Z')
})

Deno.test('parseDateBound treats missing/empty as no bound', () => {
  assertEquals(parseDateBound(undefined, 'start'), null)
  assertEquals(parseDateBound(null, 'end'), null)
  assertEquals(parseDateBound('   ', 'start'), null)
})

Deno.test('parseDateBound rejects garbage and non-strings', () => {
  assertEquals(parseDateBound('last tuesday', 'start'), 'invalid')
  assertEquals(parseDateBound('2026-13-45', 'end'), 'invalid')
  assertEquals(parseDateBound(42, 'start'), 'invalid')
})

Deno.test('dateColumn defaults to created_at and accepts either spelling of updated', () => {
  assertEquals(dateColumn(undefined), 'created_at')
  assertEquals(dateColumn('created'), 'created_at')
  assertEquals(dateColumn('nonsense'), 'created_at')
  assertEquals(dateColumn('updated'), 'updated_at')
  assertEquals(dateColumn('Updated_At'), 'updated_at')
})
