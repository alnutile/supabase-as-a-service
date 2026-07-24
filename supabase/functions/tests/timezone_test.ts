// deno test — the pure timezone helpers (isValidTimezone / formatInZone /
// currentTimeSection). No DB; every case pins an explicit instant so the
// formatting is deterministic (vitest/Deno ship full ICU).
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { currentTimeSection, formatInZone, isValidTimezone } from '../_shared/timezone.ts'

Deno.test('isValidTimezone: accepts real IANA zones', () => {
  assertEquals(isValidTimezone('UTC'), true)
  assertEquals(isValidTimezone('America/New_York'), true)
  assertEquals(isValidTimezone('Europe/London'), true)
  assertEquals(isValidTimezone('  Asia/Tokyo  '), true) // trimmed
})

Deno.test('isValidTimezone: rejects empty / garbage zones', () => {
  assertEquals(isValidTimezone(''), false)
  assertEquals(isValidTimezone('   '), false)
  assertEquals(isValidTimezone('Not/AZone'), false)
  assertEquals(isValidTimezone('EST5EDT nonsense'), false)
})

Deno.test('formatInZone: renders the same instant in different zones', () => {
  const noon = new Date('2026-07-24T16:04:00Z') // 12:04 EDT / 09:04 PDT
  const ny = formatInZone(noon, 'America/New_York')
  assertStringIncludes(ny, '2026')
  assertStringIncludes(ny, 'July')
  assertStringIncludes(ny, '12:04')
  const la = formatInZone(noon, 'America/Los_Angeles')
  assertStringIncludes(la, '9:04')
})

Deno.test('formatInZone: falls back to UTC for an invalid zone', () => {
  const t = new Date('2026-07-24T16:04:00Z')
  assertEquals(formatInZone(t, 'Not/AZone'), formatInZone(t, 'UTC'))
})

Deno.test('currentTimeSection: titled block naming the zone and time', () => {
  const section = currentTimeSection('America/New_York', new Date('2026-07-24T16:04:00Z'))
  assertStringIncludes(section, '# Current date & time')
  assertStringIncludes(section, 'timezone: America/New_York')
  assertStringIncludes(section, '12:04')
  assert(section.includes('unless the user explicitly specifies'))
})

Deno.test('currentTimeSection: invalid zone degrades to UTC without throwing', () => {
  const section = currentTimeSection('bogus', new Date('2026-07-24T16:04:00Z'))
  assertStringIncludes(section, 'timezone: UTC')
})
