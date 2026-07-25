import { describe, expect, it } from 'vitest'
import { CRON_EXAMPLES, describeCron, isValidCron, localTimezone, nextCronRuns } from './cron'

describe('isValidCron', () => {
  it('accepts well-formed 5-field expressions (incl. L)', () => {
    expect(isValidCron('* * * * *')).toBe(true)
    expect(isValidCron('0 9 15 * *')).toBe(true)
    expect(isValidCron('0 17 L * *')).toBe(true)
    expect(isValidCron('*/30 * * * *')).toBe(true)
  })
  it('rejects malformed / wrong-arity / impossible expressions', () => {
    expect(isValidCron('')).toBe(false)
    expect(isValidCron('nonsense')).toBe(false)
    expect(isValidCron('* * * *')).toBe(false)
    expect(isValidCron('* * * * * *')).toBe(false)
    expect(isValidCron('0 0 30 2 *')).toBe(false)
  })
})

describe('describeCron', () => {
  it('describes standard expressions via cronstrue', () => {
    expect(describeCron('0 9 15 * *')).toMatch(/15/)
    expect(describeCron('0 9 * * 1-5')).toMatch(/Monday/i)
  })
  it('describes the last-day-of-month L form itself', () => {
    expect(describeCron('0 17 L * *')).toMatch(/last day of the month/i)
  })
  it('returns null for invalid input', () => {
    expect(describeCron('nonsense')).toBeNull()
    expect(describeCron('')).toBeNull()
  })
})

describe('nextCronRuns', () => {
  it('previews the next N fire times in the given timezone', () => {
    const runs = nextCronRuns('0 9 15 * *', 'UTC', 3, new Date('2026-07-01T00:00:00Z'))
    expect(runs).toHaveLength(3)
    expect(runs[0].toISOString()).toBe('2026-07-15T09:00:00.000Z')
    expect(runs[1].toISOString()).toBe('2026-08-15T09:00:00.000Z')
    expect(runs[2].toISOString()).toBe('2026-09-15T09:00:00.000Z')
  })
  it('honors the timezone offset', () => {
    const runs = nextCronRuns('0 9 15 * *', 'America/New_York', 1, new Date('2026-07-01T00:00:00Z'))
    expect(runs[0].toISOString()).toBe('2026-07-15T13:00:00.000Z') // 9am EDT
  })
  it('returns [] for invalid expressions', () => {
    expect(nextCronRuns('nonsense', 'UTC')).toEqual([])
  })
})

describe('localTimezone', () => {
  it('returns a non-empty string', () => {
    expect(typeof localTimezone()).toBe('string')
    expect(localTimezone().length).toBeGreaterThan(0)
  })
})

describe('CRON_EXAMPLES', () => {
  it('every example is a valid expression', () => {
    for (const ex of CRON_EXAMPLES) expect(isValidCron(ex.expr)).toBe(true)
  })
})
