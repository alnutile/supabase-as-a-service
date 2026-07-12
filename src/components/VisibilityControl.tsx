import { useState } from 'react'
import type { Visibility } from '../lib/database.types'
import { validateSharePassword } from '../lib/artifactShare'
import { GlobeIcon, LinkIcon, LockIcon, EyeIcon, EyeOffIcon } from './icons'

const OPTIONS: { value: Visibility; label: string; hint: string; Icon: typeof LockIcon }[] = [
  { value: 'private', label: 'Private', hint: 'Only you', Icon: LockIcon },
  { value: 'unlisted', label: 'Unlisted', hint: 'Anyone with the link', Icon: LinkIcon },
  { value: 'public', label: 'Public', hint: 'Discoverable link', Icon: GlobeIcon },
]

// Optional "require a password to view" controls for a shared artifact. Passed
// in by the editor; when absent the password section isn't rendered.
export type SharePasswordProps = {
  protectedWithPassword: boolean
  onSave: (password: string) => Promise<void>
  onRemove: () => Promise<void>
}

export function VisibilityControl({
  visibility,
  shareUrl,
  onChange,
  password,
}: {
  visibility: Visibility
  shareUrl: string | null
  onChange: (v: Visibility) => void
  password?: SharePasswordProps
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

      {visibility !== 'private' && password && <SharePassword {...password} />}
    </div>
  )
}

function SharePassword({ protectedWithPassword, onSave, onRemove }: SharePasswordProps) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  async function save() {
    const err = validateSharePassword(value)
    if (err) {
      setError(err)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave(value)
      setValue('')
      setOpen(false)
    } catch {
      setError('Couldn’t save the password. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await onRemove()
      setValue('')
      setOpen(false)
    } catch {
      setError('Couldn’t remove the password. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-muted">
          <LockIcon className="h-3.5 w-3.5" />
          {protectedWithPassword ? 'Password required' : 'No password'}
        </span>
        <div className="flex items-center gap-1.5">
          {protectedWithPassword && !open && (
            <button
              onClick={remove}
              disabled={busy}
              className="rounded-md px-2 py-1 font-medium text-muted hover:text-red-600 disabled:opacity-50"
            >
              Remove
            </button>
          )}
          <button
            onClick={() => {
              setOpen((o) => !o)
              setError(null)
            }}
            className="rounded-md px-2 py-1 font-medium text-primary hover:underline"
          >
            {open ? 'Cancel' : protectedWithPassword ? 'Change' : 'Add password'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2 space-y-1.5">
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
              placeholder="Password viewers must enter"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 pr-8 text-xs text-text outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-text"
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <EyeOffIcon className="h-3.5 w-3.5" />
              ) : (
                <EyeIcon className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          <button
            onClick={save}
            disabled={busy}
            className="w-full rounded-md bg-primary px-2 py-1.5 font-medium text-white hover:bg-primary-strong disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save password'}
          </button>
        </div>
      )}
      {error && <p className="mt-1.5 text-red-600">{error}</p>}
      {!open && protectedWithPassword && (
        <p className="mt-1.5 text-faint">
          Viewers must enter this password before the artifact loads.
        </p>
      )}
    </div>
  )
}
