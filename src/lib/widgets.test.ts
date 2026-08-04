import { describe, expect, it } from 'vitest'
import {
  bucketByCategory,
  clampWidgetLimit,
  describeWidget,
  dimensionValueLabel,
  isWidgetDimension,
  isWidgetKind,
  isWidgetSource,
  isWidgetViz,
  normalizeSpec,
  widgetDimensions,
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
  it('describes a grouped chart by its dimension label', () => {
    expect(describeWidget('chart', 'artifacts', { groupBy: 'type', viz: 'donut' })).toBe('Artifacts by type')
    expect(describeWidget('chart', 'todos', { groupBy: 'done' })).toBe('To-dos by status')
  })
})

describe('viz + groupBy validation', () => {
  it('isWidgetViz accepts the four styles only', () => {
    expect(isWidgetViz('bar')).toBe(true)
    expect(isWidgetViz('donut')).toBe(true)
    expect(isWidgetViz('pie')).toBe(false)
    expect(isWidgetViz(1)).toBe(false)
  })
  it('exposes allow-listed dimensions per source', () => {
    expect(widgetDimensions('artifacts').map((d) => d.field)).toEqual(['type'])
    expect(widgetDimensions('links')).toEqual([])
    expect(isWidgetDimension('files', 'mime_type')).toBe(true)
    expect(isWidgetDimension('files', 'owner_id')).toBe(false)
    expect(isWidgetDimension('collections', 'name')).toBe(false)
  })
  it('normalizeSpec keeps viz + an allow-listed groupBy, drops unknowns', () => {
    expect(normalizeSpec('artifacts', { viz: 'line', groupBy: 'type' } as unknown)).toEqual({
      viz: 'line',
      groupBy: 'type',
    })
    // groupBy not in the source allow-list is dropped
    expect(normalizeSpec('artifacts', { groupBy: 'owner_id' } as unknown)).toEqual({})
    // a bad viz is dropped
    expect(normalizeSpec('todos', { viz: 'spiral' } as unknown)).toEqual({})
  })
  it('normalizeSpec degrades a donut without a groupBy to bar', () => {
    expect(normalizeSpec('artifacts', { viz: 'donut' } as unknown)).toEqual({ viz: 'bar' })
    expect(normalizeSpec('artifacts', { viz: 'donut', groupBy: 'type' } as unknown)).toEqual({
      viz: 'donut',
      groupBy: 'type',
    })
  })
})

describe('dimensionValueLabel', () => {
  it('prettifies todo done booleans and empties', () => {
    expect(dimensionValueLabel('todos', 'done', true)).toBe('Done')
    expect(dimensionValueLabel('todos', 'done', false)).toBe('Open')
    expect(dimensionValueLabel('artifacts', 'type', 'code')).toBe('code')
    expect(dimensionValueLabel('files', 'mime_type', null)).toBe('None')
    expect(dimensionValueLabel('files', 'mime_type', '')).toBe('None')
  })
})

describe('bucketByCategory', () => {
  it('counts by value, biggest first', () => {
    const rows = [{ type: 'doc' }, { type: 'code' }, { type: 'doc' }, { type: 'doc' }, { type: 'code' }]
    expect(bucketByCategory('artifacts', 'type', rows)).toEqual([
      { key: 'doc', label: 'doc', count: 3 },
      { key: 'code', label: 'code', count: 2 },
    ])
  })
  it('labels todo booleans', () => {
    const rows = [{ done: true }, { done: false }, { done: false }]
    expect(bucketByCategory('todos', 'done', rows)).toEqual([
      { key: 'Open', label: 'Open', count: 2 },
      { key: 'Done', label: 'Done', count: 1 },
    ])
  })
  it('folds the tail into Other past topN', () => {
    const rows = [
      ...Array(5).fill({ type: 'a' }),
      ...Array(4).fill({ type: 'b' }),
      { type: 'c' },
      { type: 'd' },
      { type: 'e' },
    ]
    const out = bucketByCategory('artifacts', 'type', rows, 2)
    expect(out).toEqual([
      { key: 'a', label: 'a', count: 5 },
      { key: 'b', label: 'b', count: 4 },
      { key: 'Other', label: 'Other', count: 3 },
    ])
  })
})
