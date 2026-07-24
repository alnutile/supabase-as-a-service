import { describe, expect, it } from 'vitest'
import {
  allTimezones,
  detectBrowserTimezone,
  formatCurrentTime,
  isValidTimezone,
  utcOffsetLabel,
} from './timezone'

describe('isValidTimezone', () => {
  it('accepts real IANA zones (trimmed)', () => {
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(isValidTimezone('  Asia/Tokyo  ')).toBe(true)
  })
  it('rejects empty and bogus zones', () => {
    expect(isValidTimezone('')).toBe(false)
    expect(isValidTimezone('   ')).toBe(false)
    expect(isValidTimezone('Not/AZone')).toBe(false)
  })
})

describe('detectBrowserTimezone', () => {
  it('returns a non-empty valid zone', () => {
    const tz = detectBrowserTimezone()
    expect(tz.length).toBeGreaterThan(0)
    expect(isValidTimezone(tz)).toBe(true)
  })
})

describe('allTimezones', () => {
  it('includes UTC, is sorted and de-duplicated', () => {
    const zones = allTimezones()
    expect(zones).toContain('UTC')
    expect(zones.length).toBeGreaterThan(5)
    expect(new Set(zones).size).toBe(zones.length)
    expect([...zones].sort()).toEqual(zones)
  })
})

describe('formatCurrentTime', () => {
  it('renders the same instant differently per zone', () => {
    const t = new Date('2026-07-24T16:04:00Z')
    const ny = formatCurrentTime('America/New_York', t)
    expect(ny).toContain('12:04')
    const la = formatCurrentTime('America/Los_Angeles', t)
    expect(la).toContain('9:04')
  })
  it('falls back to UTC for a bad zone', () => {
    const t = new Date('2026-07-24T16:04:00Z')
    expect(formatCurrentTime('bogus', t)).toBe(formatCurrentTime('UTC', t))
  })
})

describe('utcOffsetLabel', () => {
  it('reports UTC for the zero offset', () => {
    const t = new Date('2026-07-24T16:04:00Z')
    expect(utcOffsetLabel('UTC', t)).toBe('UTC')
  })
  it('reports a signed offset for other zones', () => {
    const t = new Date('2026-07-24T16:04:00Z')
    // New York is UTC-04:00 in July (EDT).
    expect(utcOffsetLabel('America/New_York', t)).toBe('UTC-04:00')
  })
})
