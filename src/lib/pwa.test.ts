import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDismissed, INSTALL_SNOOZE_MS, recordDismissed, shouldPromptInstall, SHOW_INSTALL_EVENT } from './pwa'

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

describe('clearDismissed', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('removes the dismiss timestamp from localStorage', () => {
    recordDismissed(Date.now())
    expect(localStorage.getItem('pwa.installDismissedAt')).not.toBeNull()
    clearDismissed()
    expect(localStorage.getItem('pwa.installDismissedAt')).toBeNull()
  })

  it('dispatches a custom event to show the install prompt', () => {
    const spy = vi.spyOn(window, 'dispatchEvent')
    clearDismissed()
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: SHOW_INSTALL_EVENT }))
  })

  it('does not throw when localStorage is unavailable', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'removeItem')
    setItemSpy.mockImplementation(() => {
      throw new Error('localStorage unavailable')
    })
    expect(() => clearDismissed()).not.toThrow()
    setItemSpy.mockRestore()
  })
})
