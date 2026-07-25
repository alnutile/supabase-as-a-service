import { useEffect, useState } from 'react'
import { CloseIcon, DownloadIcon } from './icons'
import { isStandalone, readDismissedAt, recordDismissed, shouldPromptInstall } from '../lib/pwa'

// The Chrome/Edge/Android `beforeinstallprompt` event — not in lib.dom yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * A small, dismissible "Install app" banner. When the browser signals the app is
 * installable it stashes the event and (unless recently dismissed / already
 * installed) offers a one-tap install. This is on top of — not a replacement for —
 * the browser's own address-bar install button, which appears automatically once
 * the manifest + service worker are in place.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isStandalone()) return

    const onBeforeInstall = (e: Event) => {
      // Stop Chrome's default mini-infobar so we control when to ask.
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
      if (shouldPromptInstall({ dismissedAt: readDismissedAt(), now: Date.now(), installed: false })) {
        setVisible(true)
      }
    }
    const onInstalled = () => {
      setVisible(false)
      setDeferred(null)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!visible || !deferred) return null

  const install = async () => {
    setVisible(false)
    try {
      await deferred.prompt()
      await deferred.userChoice
    } catch {
      // ignore — user closed the native dialog
    }
    setDeferred(null)
  }

  const dismiss = () => {
    recordDismissed(Date.now())
    setVisible(false)
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(92vw,340px)] rounded-xl border border-border bg-surface p-4 shadow-lg">
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-2 top-2 rounded-md p-1 text-faint hover:bg-bg hover:text-text"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-gradient-to-br from-primary to-primary-strong text-white"
          style={{ boxShadow: '0 4px 12px rgba(21,121,91,.35)' }}
        >
          <DownloadIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text">Install SupaNet</p>
          <p className="mt-0.5 text-xs text-faint">
            Add it to your device for a full-screen app and quick launch.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={install}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-strong"
            >
              Install
            </button>
            <button
              onClick={dismiss}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-faint hover:bg-bg hover:text-text"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
