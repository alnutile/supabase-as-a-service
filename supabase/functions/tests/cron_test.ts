// deno test — the pure cron helpers (isValidCron / nextCronRun). No DB, no clock:
// every case pins an explicit `after` instant so the next-run math is deterministic.
import { assertEquals } from 'jsr:@std/assert@1'
import { isValidCron, nextCronRun } from '../_shared/cron.ts'

Deno.test('isValidCron: accepts well-formed 5-field expressions', () => {
  assertEquals(isValidCron('* * * * *'), true)
  assertEquals(isValidCron('0 9 15 * *'), true) // 9am on the 15th
  assertEquals(isValidCron('0 9 L * *'), true) // 9am on the last day of the month
  assertEquals(isValidCron('*/15 * * * *'), true)
  assertEquals(isValidCron('0 0 1 1 *'), true)
})

Deno.test('isValidCron: rejects malformed / non-5-field / impossible expressions', () => {
  assertEquals(isValidCron(''), false)
  assertEquals(isValidCron('   '), false)
  assertEquals(isValidCron('nonsense'), false)
  assertEquals(isValidCron('* * * *'), false) // 4 fields
  assertEquals(isValidCron('* * * * * *'), false) // 6 fields (seconds not accepted)
  assertEquals(isValidCron('60 * * * *'), false) // minute out of range
  assertEquals(isValidCron('0 0 30 2 *'), false) // Feb 30 never fires
})

Deno.test('nextCronRun: monthly on the 15th (UTC)', () => {
  const before = nextCronRun('0 9 15 * *', 'UTC', new Date('2026-07-01T00:00:00Z'))
  assertEquals(before?.toISOString(), '2026-07-15T09:00:00.000Z')
  // Already past this month's 15th → rolls to next month.
  const after = nextCronRun('0 9 15 * *', 'UTC', new Date('2026-07-20T00:00:00Z'))
  assertEquals(after?.toISOString(), '2026-08-15T09:00:00.000Z')
})

Deno.test('nextCronRun: last day of month via L (UTC)', () => {
  const july = nextCronRun('0 9 L * *', 'UTC', new Date('2026-07-01T00:00:00Z'))
  assertEquals(july?.toISOString(), '2026-07-31T09:00:00.000Z')
  // Non-leap February resolves to the 28th, not a fixed 30/31.
  const feb = nextCronRun('0 9 L * *', 'UTC', new Date('2026-02-01T00:00:00Z'))
  assertEquals(feb?.toISOString(), '2026-02-28T09:00:00.000Z')
})

Deno.test('nextCronRun: evaluates in the given timezone', () => {
  // 9am on the 15th in New York (EDT, UTC-4 in July) → 13:00 UTC.
  const ny = nextCronRun('0 9 15 * *', 'America/New_York', new Date('2026-07-01T00:00:00Z'))
  assertEquals(ny?.toISOString(), '2026-07-15T13:00:00.000Z')
})

Deno.test('nextCronRun: strictly after the given instant', () => {
  const next = nextCronRun('* * * * *', 'UTC', new Date('2026-07-15T12:00:00Z'))
  assertEquals(next?.toISOString(), '2026-07-15T12:01:00.000Z')
})

Deno.test('nextCronRun: null for invalid input', () => {
  assertEquals(nextCronRun('', 'UTC', new Date()), null)
  assertEquals(nextCronRun('nonsense', 'UTC', new Date()), null)
  assertEquals(nextCronRun('* * * *', 'UTC', new Date()), null)
})
