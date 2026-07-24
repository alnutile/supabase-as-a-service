// PWA helpers.
//
// The install UX (the `beforeinstallprompt` event) and service-worker APIs are
// browser-only. The "should we show our own install banner right now" decision is
// pure so it's unit-testable (per CLAUDE.md — keep testable logic out of
// components); the thin browser-glue lives alongside it.

const DISMISS_KEY = 'pwa.installDismissedAt'
// After a user dismisses our banner, don't re-surface it for two weeks. The
// browser's own address-bar install affordance is unaffected either way.
export const INSTALL_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Whether to surface our own install banner. Pure so the snooze window is
 * testable. `dismissedAt`/`now` are epoch milliseconds.
 */
export function shouldPromptInstall(opts: {
  dismissedAt: number | null
  now: number
  installed: boolean
}): boolean {
  if (opts.installed) return false
  if (opts.dismissedAt == null) return true
  return opts.now - opts.dismissedAt >= INSTALL_SNOOZE_MS
}

export function readDismissedAt(): number | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function recordDismissed(now: number): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(now))
  } catch {
    // ignore — a full/blocked storage must never break the UI
  }
}

/** True when the app is already running as an installed PWA. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    // iOS Safari doesn't set display-mode; it exposes this instead.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

/**
 * Register the service worker. Safe to call unconditionally — a failed
 * registration is swallowed so it can never break app boot. Registers after
 * `load` so it doesn't contend with the initial render.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // ignore
    })
  })
}
