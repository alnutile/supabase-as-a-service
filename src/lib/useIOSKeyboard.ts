import { useEffect, useState } from 'react'

/**
 * Hook to detect and handle iOS keyboard appearance.
 *
 * On iOS, when the keyboard appears, the visual viewport shrinks but the layout
 * viewport stays the same. This causes issues where the focused input is hidden
 * behind the keyboard. This hook detects the keyboard state and provides the
 * visual viewport height to adjust layouts accordingly.
 *
 * Returns the current visual viewport height (in px) and whether the keyboard
 * is currently shown. Falls back to window.innerHeight when the Visual Viewport
 * API is not available.
 */
export function useIOSKeyboard() {
  const [viewportHeight, setViewportHeight] = useState(() => {
    // Initialize with visual viewport height if available, else window height
    return window.visualViewport?.height ?? window.innerHeight
  })

  const [isKeyboardShown, setIsKeyboardShown] = useState(false)

  useEffect(() => {
    // Only run this effect in browsers that support the Visual Viewport API
    const visualViewport = window.visualViewport
    if (!visualViewport) {
      return
    }

    const handleResize = () => {
      const newHeight = visualViewport.height
      setViewportHeight(newHeight)

      // Detect keyboard: if the visual viewport height is significantly smaller
      // than the window height, the keyboard is likely shown. Use a threshold
      // to avoid false positives from browser chrome changes.
      const heightDiff = window.innerHeight - newHeight
      setIsKeyboardShown(heightDiff > 100)
    }

    // Listen to visual viewport resize events
    visualViewport.addEventListener('resize', handleResize)

    // Also listen to scroll events to handle cases where the keyboard triggers
    // a scroll without a resize
    visualViewport.addEventListener('scroll', handleResize)

    return () => {
      visualViewport.removeEventListener('resize', handleResize)
      visualViewport.removeEventListener('scroll', handleResize)
    }
  }, [])

  return { viewportHeight, isKeyboardShown }
}
