import { describe, expect, it } from 'vitest'
import { formatCost, formatDuration, formatTokens, runDurationMs, statusTone, surfaceLabel } from './agentRuns'

describe('runDurationMs', () => {
  it('computes elapsed ms between start and end', () => {
    expect(runDurationMs({ started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:02.5Z', status: 'done' })).toBe(2500)
  })
  it('returns null while still running', () => {
    expect(runDurationMs({ started_at: '2026-01-01T00:00:00Z', ended_at: null, status: 'running' })).toBeNull()
  })
  it('returns null for an inverted or unparseable range', () => {
    expect(runDurationMs({ started_at: '2026-01-01T00:00:05Z', ended_at: '2026-01-01T00:00:00Z', status: 'done' })).toBeNull()
    expect(runDurationMs({ started_at: 'nope', ended_at: 'also nope', status: 'done' })).toBeNull()
  })
})

describe('formatDuration', () => {
  it('formats sub-second, seconds, and minutes', () => {
    expect(formatDuration(340)).toBe('340ms')
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(12000)).toBe('12s')
    expect(formatDuration(125000)).toBe('2m 5s')
  })
  it('handles null/negative', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
  })
})

describe('statusTone', () => {
  it('maps known statuses and falls back to slate', () => {
    expect(statusTone('running')).toBe('amber')
    expect(statusTone('done')).toBe('emerald')
    expect(statusTone('error')).toBe('rose')
    expect(statusTone('whatever')).toBe('slate')
  })
})

describe('surfaceLabel', () => {
  it('labels known surfaces and passes through unknown', () => {
    expect(surfaceLabel('schedule')).toBe('Scheduled')
    expect(surfaceLabel('slack')).toBe('Slack')
    expect(surfaceLabel('mystery')).toBe('mystery')
  })
})

describe('formatTokens', () => {
  it('groups thousands and handles null', () => {
    expect(formatTokens(12345)).toBe('12,345')
    expect(formatTokens(null)).toBe('—')
  })
})

describe('formatCost', () => {
  it('shows sub-cent precision and zero', () => {
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(null)).toBe('$0')
    expect(formatCost(0.0004)).toBe('$0.0004')
    expect(formatCost(1.239)).toBe('$1.24')
  })
})
