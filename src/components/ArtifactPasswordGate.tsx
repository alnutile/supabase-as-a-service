import { useCallback, useEffect, useState } from 'react'
import type { Database } from '../lib/database.types'
import { supabase } from '../lib/supabase'
import { shareGateFromMeta } from '../lib/artifactShare'
import { LockIcon } from './icons'

// The columns get_shared_artifact() returns — a superset-safe subset of the
// artifacts Row (a normal RLS read is assignable to it), minus the password hash.
export type SharedArtifact = Database['public']['Functions']['get_shared_artifact']['Returns'][number]

type Status = 'loading' | 'ready' | 'password' | 'missing'

// Loads a shared artifact for the public viewer pages, handling the optional
// share password (migration 0060). Fast path: a normal RLS read returns
// non-password shared rows directly. If that comes back empty the row is either
// private/absent or password-protected (hidden from anon), so we ask
// `artifact_share_meta` which case it is, then verify via `get_shared_artifact`.
export function useSharedArtifact(slug: string | undefined) {
  const [status, setStatus] = useState<Status>('loading')
  const [artifact, setArtifact] = useState<SharedArtifact | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    setStatus('loading')
    setArtifact(null)
    ;(async () => {
      const { data } = await supabase.from('artifacts').select('*').eq('public_slug', slug).maybeSingle()
      if (cancelled) return
      if (data) {
        setArtifact(data)
        setStatus('ready')
        return
      }
      const { data: meta } = await supabase.rpc('artifact_share_meta', { p_slug: slug })
      if (cancelled) return
      setStatus(shareGateFromMeta(meta?.[0]))
    })()
    return () => {
      cancelled = true
    }
  }, [slug])

  const submitPassword = useCallback(
    async (password: string) => {
      if (!slug) return
      setSubmitting(true)
      setError(null)
      const { data } = await supabase.rpc('get_shared_artifact', {
        p_slug: slug,
        p_password: password,
      })
      setSubmitting(false)
      if (data && data[0]) {
        setArtifact(data[0])
        setStatus('ready')
      } else {
        setError('Incorrect password. Try again.')
      }
    },
    [slug],
  )

  return { status, artifact, error, submitting, submitPassword }
}

// The password prompt a viewer sees for a password-protected shared artifact.
export function ArtifactPasswordGate({
  onSubmit,
  error,
  submitting,
}: {
  onSubmit: (password: string) => void
  error: string | null
  submitting: boolean
}) {
  const [value, setValue] = useState('')

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted">
        <LockIcon className="h-6 w-6" />
      </span>
      <div>
        <p className="text-lg font-semibold text-text">This artifact is password protected</p>
        <p className="mt-1 text-sm text-muted">
          Enter the password you were given to view it.
        </p>
      </div>
      <form
        className="w-full space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (value && !submitting) onSubmit(value)
        }}
      >
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={!value || submitting}
          className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition hover:bg-primary-strong disabled:opacity-50"
        >
          {submitting ? 'Checking…' : 'View artifact'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </div>
  )
}
