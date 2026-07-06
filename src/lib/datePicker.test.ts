import { describe, expect, it, vi } from 'vitest'
import { openDatePicker } from './datePicker'

describe('openDatePicker', () => {
  it('calls showPicker on the element and reports success', () => {
    const showPicker = vi.fn()
    expect(openDatePicker({ showPicker })).toBe(true)
    expect(showPicker).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for a null/undefined element', () => {
    expect(openDatePicker(null)).toBe(false)
    expect(openDatePicker(undefined)).toBe(false)
  })

  it('falls back gracefully when showPicker is unsupported', () => {
    // Older browsers: no showPicker method at all.
    expect(openDatePicker({} as unknown as HTMLInputElement)).toBe(false)
  })

  it('swallows a thrown showPicker (e.g. not a user gesture / cross-origin)', () => {
    const showPicker = vi.fn(() => {
      throw new Error('NotAllowedError')
    })
    expect(openDatePicker({ showPicker })).toBe(false)
    expect(showPicker).toHaveBeenCalledTimes(1)
  })
})
