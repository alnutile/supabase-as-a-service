import { describe, expect, it } from 'vitest'
import {
  clampWidgetLimit,
  describeWidget,
  isWidgetKind,
  isWidgetSource,
  normalizeSpec,
  windowStartISO,
} from './widgets'

describe('isWidgetKind / isWidgetSource', () => {
  it('accepts known values', () => {
    expect(isWidgetKind('stat')).toBe(true)
    expect(isWidgetKind('list')).toBe(true)
    expect(isWidgetKind('chart')).toBe(true)
    expect(isWidgetSource('todos')).toBe(true)
    expect(isWidgetSource('activity')).toBe(true)
  })
  it('rejects unknown / non-string values', () => {
    expect(isWidgetKind('pie')).toBe(false)
    expect(isWidgetKind(3)).toBe(false)
    expect(isWidgetSource('users')).toBe(false)
    expect(isWidgetSource('__proto__')).toBe(false)
  })
})

describe('clampWidgetLimit', () => {
  it('defaults and clamps', () => {
    expect(clampWidgetLimit(undefined)).toBe(5)
    expect(clampWidgetLimit(0)).toBe(1)
    expect(clampWidgetLimit(3)).toBe(3)
    expect(clampWidgetLimit(999)).toBe(20)
    expect(clampWidgetLimit('7' as unknown)).toBe(5)
  })
})

describe('windowStartISO', () => {
  const now = new Date('2026-07-15T12:00:00Z')
  it('returns null for all/undefined', () => {
    expect(windowStartISO(undefined, now)).toBeNull()
    expect(windowStartISO('all', now)).toBeNull()
  })
  it('computes 7d/30d offsets', () => {
    expect(windowStartISO('7d', now)).toBe('2026-07-08T12:00:00.000Z')
    expect(windowStartISO('30d', now)).toBe('2026-06-15T12:00:00.000Z')
  })
  it('today is midnight-relative (not 24h)', () => {
    // Exact value is locale-tz dependent; assert it is <= now and not the 7d value.
    const t = windowStartISO('today', now)
    expect(t).not.toBeNull()
    expect(new Date(t as string).getTime()).toBeLessThanOrEqual(now.getTime())
  })
})

describe('normalizeSpec', () => {
  it('keeps only known fields', () => {
    const spec = normalizeSpec('todos', {
      window: '7d',
      mine: true,
      status: 'open',
      limit: 8,
      evil: 'DROP TABLE',
      injected: { a: 1 },
    } as unknown)
    expect(spec).toEqual({ window: '7d', mine: true, status: 'open', limit: 8 })
  })
  it('drops status for sources that do not support it', () => {
    expect(normalizeSpec('files', { status: 'done' } as unknown).status).toBeUndefined()
  })
  it('ignores mine:false and bad windows', () => {
    expect(normalizeSpec('artifacts', { mine: false, window: 'forever' } as unknown)).toEqual({})
  })
  it('clamps the limit', () => {
    expect(normalizeSpec('links', { limit: 100 } as unknown).limit).toBe(20)
  })
})

describe('describeWidget', () => {
  it('describes each kind', () => {
    expect(describeWidget('stat', 'todos', { mine: true, status: 'open' })).toBe('Count of my open to-dos')
    expect(describeWidget('list', 'artifacts', { window: '7d' })).toBe('Latest artifacts last 7 days')
    expect(describeWidget('chart', 'activity', {})).toContain('Activity per day')
  })
})
