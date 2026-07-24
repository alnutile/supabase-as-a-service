import { describe, expect, it } from 'vitest'
import { INSTALL_SNOOZE_MS, shouldPromptInstall } from './pwa'

describe('shouldPromptInstall', () => {
  const now = 1_700_000_000_000

  it('prompts on a fresh install (never dismissed, not installed)', () => {
    expect(shouldPromptInstall({ dismissedAt: null, now, installed: false })).toBe(true)
  })

  it('never prompts when already installed', () => {
    expect(shouldPromptInstall({ dismissedAt: null, now, installed: true })).toBe(false)
    expect(shouldPromptInstall({ dismissedAt: now - INSTALL_SNOOZE_MS * 2, now, installed: true })).toBe(
      false,
    )
  })

  it('stays hidden inside the snooze window after a dismissal', () => {
    const dismissedAt = now - (INSTALL_SNOOZE_MS - 1000)
    expect(shouldPromptInstall({ dismissedAt, now, installed: false })).toBe(false)
  })

  it('re-prompts once the snooze window has elapsed', () => {
    const dismissedAt = now - INSTALL_SNOOZE_MS
    expect(shouldPromptInstall({ dismissedAt, now, installed: false })).toBe(true)
  })
})
