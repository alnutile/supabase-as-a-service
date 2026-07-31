import { describe, expect, it } from 'vitest'
import {
  SHARE_MODES,
  shareExpirySeconds,
  shareModeLabel,
  shareValidityNote,
  type ShareMode,
} from './fileShare'

describe('shareExpirySeconds', () => {
  it('maps signed modes to the right window in seconds', () => {
    expect(shareExpirySeconds('1h')).toBe(3600)
    expect(shareExpirySeconds('1d')).toBe(86400)
    expect(shareExpirySeconds('1w')).toBe(604800)
  })

  it('returns null for public (no expiry)', () => {
    expect(shareExpirySeconds('public')).toBeNull()
  })
})

describe('shareModeLabel', () => {
  it('labels every mode', () => {
    const labels = SHARE_MODES.map(shareModeLabel)
    expect(labels).toEqual(['Public', '1 hour', '1 day', '1 week'])
  })
})

describe('shareValidityNote', () => {
  it('distinguishes permanent public links from expiring signed links', () => {
    expect(shareValidityNote('public')).toMatch(/permanent/i)
    expect(shareValidityNote('1w')).toContain('1 week')
    expect(shareValidityNote('1w')).toMatch(/signed/i)
  })
})

describe('SHARE_MODES', () => {
  it('covers exactly the four modes with no duplicates', () => {
    const set = new Set<ShareMode>(SHARE_MODES)
    expect(set.size).toBe(4)
    expect(set).toEqual(new Set<ShareMode>(['public', '1h', '1d', '1w']))
  })
})
