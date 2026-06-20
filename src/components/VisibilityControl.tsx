import { useState } from 'react'
import type { Visibility } from '../lib/database.types'
import { GlobeIcon, LinkIcon, LockIcon } from './icons'

const OPTIONS: { value: Visibility; label: string; hint: string; Icon: typeof LockIcon }[] = [
  { value: 'private', label: 'Private', hint: 'Only you', Icon: LockIcon },
  { value: 'unlisted', label: 'Unlisted', hint: 'Anyone with the link', Icon: LinkIcon },
  { value: 'public', label: 'Public', hint: 'Discoverable link', Icon: GlobeIcon },
]

export function VisibilityControl({
  visibility,
  shareUrl,
  onChange,
}: {
  visibility: Visibility
  shareUrl: string | null
  onChange: (v: Visibility) => void
}) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="space-y-2">
      <div className="flex rounded-lg bg-surface-2 p-1 text-sm">
        {OPTIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            onClick={() => onChange(value)}
            title={OPTIONS.find((o) => o.value === value)?.hint}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium transition ${
              visibility === value
                ? 'bg-surface text-text shadow-sm'
                : 'text-muted hover:text-text'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {visibility !== 'private' && shareUrl && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2 py-1.5">
          <input
            readOnly
            value={shareUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 bg-transparent text-xs text-muted outline-none"
          />
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(shareUrl)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            className="shrink-0 rounded-md bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary-strong"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  )
}
