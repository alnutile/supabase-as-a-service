import { describe, expect, it } from 'vitest'
import { activityFamily, bucketByDay, completionPct, timeAgo } from './dashboard'

describe('bucketByDay', () => {
  const now = new Date('2026-07-15T12:00:00')

  it('returns one bucket per day, oldest first', () => {
    const b = bucketByDay([], 7, now)
    expect(b).toHaveLength(7)
    expect(b[0].key).toBe('2026-07-09')
    expect(b[6].key).toBe('2026-07-15')
  })

  it('counts rows into the right day and ignores out-of-window rows', () => {
    const rows = [
      { created_at: '2026-07-15T09:00:00' },
      { created_at: '2026-07-15T23:30:00' },
      { created_at: '2026-07-13T01:00:00' },
      { created_at: '2026-06-01T01:00:00' }, // outside 7-day window
    ]
    const b = bucketByDay(rows, 7, now)
    expect(b.find((x) => x.key === '2026-07-15')?.count).toBe(2)
    expect(b.find((x) => x.key === '2026-07-13')?.count).toBe(1)
    expect(b.reduce((s, x) => s + x.count, 0)).toBe(3)
  })
})

describe('completionPct', () => {
  it('is 0 when nothing exists', () => {
    expect(completionPct(0, 0)).toBe(0)
  })
  it('rounds to a whole percent', () => {
    expect(completionPct(1, 3)).toBe(33)
    expect(completionPct(2, 3)).toBe(67)
    expect(completionPct(5, 5)).toBe(100)
  })
})

describe('timeAgo', () => {
  const now = new Date('2026-07-15T12:00:00Z')
  it('formats recent times compactly', () => {
    expect(timeAgo('2026-07-15T11:59:40Z', now)).toBe('just now')
    expect(timeAgo('2026-07-15T11:45:00Z', now)).toBe('15m ago')
    expect(timeAgo('2026-07-15T09:00:00Z', now)).toBe('3h ago')
    expect(timeAgo('2026-07-13T12:00:00Z', now)).toBe('2d ago')
    expect(timeAgo('2026-07-01T12:00:00Z', now)).toBe('2w ago')
  })
})

describe('activityFamily', () => {
  it('maps types to families with a dot colour', () => {
    expect(activityFamily('chat.completed').key).toBe('chat')
    expect(activityFamily('artifact.created').key).toBe('artifact')
    expect(activityFamily('schedule.run').key).toBe('schedule')
    expect(activityFamily('todo.created').key).toBe('todo')
    expect(activityFamily('something.weird').key).toBe('other')
  })
  it('errors win over the base family', () => {
    expect(activityFamily('tool.error').key).toBe('error')
  })
  it('every family carries a non-empty label and dot', () => {
    for (const t of ['chat.x', 'file.y', 'zzz.z']) {
      const f = activityFamily(t)
      expect(f.label.length).toBeGreaterThan(0)
      expect(f.dot).toMatch(/^bg-/)
    }
  })
})
