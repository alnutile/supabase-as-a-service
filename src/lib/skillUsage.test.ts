import { describe, it, expect } from 'vitest'
import {
  indexUsage,
  daysSinceUsed,
  isStale,
  usageLabel,
  staleCount,
  DEFAULT_STALE_DAYS,
  type SkillUsageStat,
} from './skillUsage'

const NOW = new Date('2026-08-02T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const stat = (over: Partial<SkillUsageStat>): SkillUsageStat => ({
  skill_id: 's',
  run_count: 1,
  last_used_at: daysAgo(1),
  ...over,
})

describe('indexUsage', () => {
  it('keys rows by skill id', () => {
    const map = indexUsage([stat({ skill_id: 'a' }), stat({ skill_id: 'b' })])
    expect(Object.keys(map).sort()).toEqual(['a', 'b'])
    expect(map.a.skill_id).toBe('a')
  })

  it('tolerates null/undefined input', () => {
    expect(indexUsage(null)).toEqual({})
    expect(indexUsage(undefined)).toEqual({})
  })
})

describe('daysSinceUsed', () => {
  it('returns whole days since last use', () => {
    expect(daysSinceUsed(stat({ last_used_at: daysAgo(3) }), NOW)).toBe(3)
  })

  it('is null when never used', () => {
    expect(daysSinceUsed(stat({ last_used_at: null }), NOW)).toBeNull()
    expect(daysSinceUsed(undefined, NOW)).toBeNull()
  })

  it('is null for an unparseable timestamp', () => {
    expect(daysSinceUsed(stat({ last_used_at: 'not-a-date' }), NOW)).toBeNull()
  })
})

describe('isStale', () => {
  it('treats never-used as stale', () => {
    expect(isStale(stat({ last_used_at: null, run_count: 0 }), 30, NOW)).toBe(true)
    expect(isStale(undefined, 30, NOW)).toBe(true)
  })

  it('is fresh within the window and stale at/after it', () => {
    expect(isStale(stat({ last_used_at: daysAgo(29) }), 30, NOW)).toBe(false)
    expect(isStale(stat({ last_used_at: daysAgo(30) }), 30, NOW)).toBe(true)
    expect(isStale(stat({ last_used_at: daysAgo(45) }), 30, NOW)).toBe(true)
  })

  it('defaults to DEFAULT_STALE_DAYS', () => {
    expect(isStale(stat({ last_used_at: daysAgo(DEFAULT_STALE_DAYS) }), undefined, NOW)).toBe(true)
    expect(isStale(stat({ last_used_at: daysAgo(DEFAULT_STALE_DAYS - 1) }), undefined, NOW)).toBe(false)
  })
})

describe('usageLabel', () => {
  it('formats counts and the never-used case', () => {
    expect(usageLabel(undefined)).toBe('Never used')
    expect(usageLabel(stat({ run_count: 0 }))).toBe('Never used')
    expect(usageLabel(stat({ run_count: 1 }))).toBe('Used 1×')
    expect(usageLabel(stat({ run_count: 12 }))).toBe('Used 12×')
  })
})

describe('staleCount', () => {
  it('counts prune candidates (never-used + beyond window)', () => {
    const usage = indexUsage([
      stat({ skill_id: 'fresh', last_used_at: daysAgo(2) }),
      stat({ skill_id: 'old', last_used_at: daysAgo(90) }),
      // 'never' is absent from the map entirely
    ])
    expect(staleCount(['fresh', 'old', 'never'], usage, 30, NOW)).toBe(2)
  })
})
