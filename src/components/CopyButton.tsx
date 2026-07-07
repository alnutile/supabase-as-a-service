import { useState } from 'react'
import { CopyIcon, CheckIcon } from './icons'

// Small "copy to clipboard" affordance reused wherever we want to hand a chunk
// of text (a chat answer, an artifact body) to the user in one click. It owns
// its own transient "Copied!" state so callers just pass the text.
export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied!',
  title = 'Copy to clipboard',
  className = '',
  iconClassName = 'h-3.5 w-3.5',
}: {
  text: string
  label?: string | null
  copiedLabel?: string
  title?: string
  className?: string
  iconClassName?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    const ok = await copyText(text)
    if (!ok) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      aria-label={title}
      className={className}
    >
      {copied ? <CheckIcon className={iconClassName} /> : <CopyIcon className={iconClassName} />}
      {label !== null && <span>{copied ? copiedLabel : label}</span>}
    </button>
  )
}

// Clipboard write with a legacy fallback (execCommand) for browsers/contexts
// where navigator.clipboard is unavailable (non-secure origins, older WebViews).
// Returns whether the copy succeeded — extracted so it can be unit-tested.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
