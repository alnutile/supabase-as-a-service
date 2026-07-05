import { describe, expect, it } from 'vitest'
import { formatBytes, makeSlug, skillInvocationSentence } from './util'
import { estimateTokens, estimateTokensFromChars, formatCount } from './tokens'

describe('makeSlug', () => {
  it('makes URL-safe slugs of the requested length', () => {
    expect(makeSlug()).toMatch(/^[a-z0-9]{10}$/)
    expect(makeSlug(24)).toMatch(/^[a-z0-9]{24}$/)
  })

  it('is (overwhelmingly) unique per call', () => {
    expect(makeSlug()).not.toBe(makeSlug())
  })
})

describe('formatBytes', () => {
  it('handles null and zero', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(0)).toBe('0 B')
  })

  it('scales units and rounds small values to one decimal', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(150 * 1024)).toBe('150 KB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
})

describe('skillInvocationSentence', () => {
  it('wraps the skill name in a quoted "use the skill" prompt', () => {
    expect(skillInvocationSentence('Summarize')).toBe('use the skill "Summarize"')
  })

  it('trims surrounding whitespace from the name', () => {
    expect(skillInvocationSentence('  Weekly report  ')).toBe('use the skill "Weekly report"')
  })
})

describe('token estimates', () => {
  it('uses the ~4 chars/token heuristic, rounding up', () => {
    expect(estimateTokensFromChars(0)).toBe(0)
    expect(estimateTokensFromChars(1)).toBe(1)
    expect(estimateTokensFromChars(4000)).toBe(1000)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens(undefined)).toBe(0)
  })

  it('formats counts compactly', () => {
    expect(formatCount(950)).toBe('950')
    expect(formatCount(1200)).toBe('1.2K')
    expect(formatCount(12_000)).toBe('12K')
    expect(formatCount(1_200_000)).toBe('1.2M')
  })
})
