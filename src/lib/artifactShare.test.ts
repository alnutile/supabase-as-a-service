import { describe, expect, it } from 'vitest'
import {
  MIN_SHARE_PASSWORD_LENGTH,
  shareGateFromMeta,
  validateSharePassword,
} from './artifactShare'

describe('validateSharePassword', () => {
  it('rejects an empty or whitespace-only password', () => {
    expect(validateSharePassword('')).toMatch(/enter a password/i)
    expect(validateSharePassword('   ')).toMatch(/enter a password/i)
  })

  it('rejects a password shorter than the minimum', () => {
    expect(validateSharePassword('ab')).toMatch(new RegExp(`${MIN_SHARE_PASSWORD_LENGTH}`))
  })

  it('accepts a password at or above the minimum length', () => {
    expect(validateSharePassword('hunter2')).toBeNull()
    expect(validateSharePassword('a'.repeat(MIN_SHARE_PASSWORD_LENGTH))).toBeNull()
  })

  it('counts leading/trailing spaces toward length but not toward emptiness', () => {
    // 5 chars incl. a trailing space — long enough and not all-whitespace.
    expect(validateSharePassword('abcd ')).toBeNull()
  })
})

describe('shareGateFromMeta', () => {
  it('treats a null/undefined or not-found meta as missing', () => {
    expect(shareGateFromMeta(null)).toBe('missing')
    expect(shareGateFromMeta(undefined)).toBe('missing')
    expect(shareGateFromMeta({ found: false, requires_password: false })).toBe('missing')
  })

  it('asks for a password when the shared artifact is protected', () => {
    expect(shareGateFromMeta({ found: true, requires_password: true })).toBe('password')
  })

  it('is ready when found without a password requirement', () => {
    expect(shareGateFromMeta({ found: true, requires_password: false })).toBe('ready')
  })
})
