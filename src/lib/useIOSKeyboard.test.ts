import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIOSKeyboard } from './useIOSKeyboard'

describe('useIOSKeyboard', () => {
  let mockVisualViewport: {
    height: number
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    // Mock the visual viewport API
    mockVisualViewport = {
      height: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }

    // @ts-expect-error - mocking window.visualViewport
    window.visualViewport = mockVisualViewport
    window.innerHeight = 800
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should initialize with the visual viewport height', () => {
    const { result } = renderHook(() => useIOSKeyboard())

    expect(result.current.viewportHeight).toBe(800)
    expect(result.current.isKeyboardShown).toBe(false)
  })

  it('should detect keyboard when viewport height decreases significantly', () => {
    const { result, rerender } = renderHook(() => useIOSKeyboard())

    // Get the resize handler that was registered
    const resizeHandler = mockVisualViewport.addEventListener.mock.calls.find(
      call => call[0] === 'resize'
    )?.[1]

    expect(resizeHandler).toBeDefined()

    // Simulate keyboard appearing (viewport height decreases by more than 100px)
    mockVisualViewport.height = 400
    resizeHandler?.()
    rerender()

    expect(result.current.viewportHeight).toBe(400)
    expect(result.current.isKeyboardShown).toBe(true)
  })

  it('should not detect keyboard for small viewport changes', () => {
    const { result, rerender } = renderHook(() => useIOSKeyboard())

    const resizeHandler = mockVisualViewport.addEventListener.mock.calls.find(
      call => call[0] === 'resize'
    )?.[1]

    // Simulate small viewport change (e.g., browser chrome appearing)
    mockVisualViewport.height = 750
    resizeHandler?.()
    rerender()

    expect(result.current.viewportHeight).toBe(750)
    expect(result.current.isKeyboardShown).toBe(false)
  })

  it('should handle keyboard dismissal', () => {
    const { result, rerender } = renderHook(() => useIOSKeyboard())

    const resizeHandler = mockVisualViewport.addEventListener.mock.calls.find(
      call => call[0] === 'resize'
    )?.[1]

    // Show keyboard
    mockVisualViewport.height = 400
    resizeHandler?.()
    rerender()

    expect(result.current.isKeyboardShown).toBe(true)

    // Dismiss keyboard
    mockVisualViewport.height = 800
    resizeHandler?.()
    rerender()

    expect(result.current.viewportHeight).toBe(800)
    expect(result.current.isKeyboardShown).toBe(false)
  })

  it('should register both resize and scroll listeners', () => {
    renderHook(() => useIOSKeyboard())

    expect(mockVisualViewport.addEventListener).toHaveBeenCalledWith(
      'resize',
      expect.any(Function)
    )
    expect(mockVisualViewport.addEventListener).toHaveBeenCalledWith(
      'scroll',
      expect.any(Function)
    )
  })

  it('should clean up listeners on unmount', () => {
    const { unmount } = renderHook(() => useIOSKeyboard())

    const resizeHandler = mockVisualViewport.addEventListener.mock.calls.find(
      call => call[0] === 'resize'
    )?.[1]
    const scrollHandler = mockVisualViewport.addEventListener.mock.calls.find(
      call => call[0] === 'scroll'
    )?.[1]

    unmount()

    expect(mockVisualViewport.removeEventListener).toHaveBeenCalledWith(
      'resize',
      resizeHandler
    )
    expect(mockVisualViewport.removeEventListener).toHaveBeenCalledWith(
      'scroll',
      scrollHandler
    )
  })

  it('should fall back to window.innerHeight when visualViewport is not available', () => {
    delete (window as { visualViewport?: unknown }).visualViewport

    const { result } = renderHook(() => useIOSKeyboard())

    expect(result.current.viewportHeight).toBe(800)
    expect(result.current.isKeyboardShown).toBe(false)
  })
})
