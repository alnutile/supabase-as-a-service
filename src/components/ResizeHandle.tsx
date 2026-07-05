import { useCallback, useRef, useState } from 'react'

// Drag-to-resize for a right-hand side panel (artifact preview/live panel).
// The handle sits on the panel's LEFT edge; dragging left widens it. Desktop
// only — on mobile these panels are full-width overlays.
//
// The width is exposed as a CSS variable (--panel-w) that callers consume
// with `md:w-[var(--panel-w)]`, so it only applies at the breakpoints where
// the panel is actually a side panel. Persisted per-panel in localStorage.
export function usePanelResize(storageKey: string, initial: number, min = 320, max = 880) {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey) ?? '')
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial
  })
  const latest = useRef(width)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const target = e.currentTarget
      const startX = e.clientX
      const startWidth = latest.current
      // Pointer capture keeps the drag alive even over the artifact iframe
      // (which would otherwise swallow the pointer events).
      target.setPointerCapture(e.pointerId)
      const onMove = (ev: PointerEvent) => {
        const w = Math.min(max, Math.max(min, startWidth + (startX - ev.clientX)))
        latest.current = w
        setWidth(w)
      }
      const onUp = () => {
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        localStorage.setItem(storageKey, String(latest.current))
      }
      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
    },
    [storageKey, min, max],
  )

  return {
    onPointerDown,
    /** Spread onto the panel: sets --panel-w for `md:w-[var(--panel-w)]`. */
    panelStyle: { '--panel-w': `${width}px` } as React.CSSProperties,
  }
}

export function ResizeHandle({
  onPointerDown,
}: {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to resize"
      className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize touch-none select-none hover:bg-primary/25 active:bg-primary/40 md:block"
    />
  )
}
