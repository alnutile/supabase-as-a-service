import { useEffect, useState } from 'react'
import { Navigate, Link, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

// Public landing for a shareable invite link (/join/:token). Validates the
// token, then lets the recipient create an account: redeeming allowlists the
// email they enter (redeem_invite_link RPC) so the invite-only signup guard
// lets it through, then we sign them up as usual.
type Status = 'checking' | 'valid' | 'invalid' | 'expired' | 'used_up'

export default function JoinPage() {
  const { token = '' } = useParams()
  const { session, signUp } = useAuth()
  const [status, setStatus] = useState<Status>('checking')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data, error: rpcErr } = await supabase.rpc('invite_link_status', {
        p_token: token,
      })
      if (!active) return
      const row = Array.isArray(data) ? data[0] : null
      if (rpcErr || !row) {
        setStatus('invalid')
        return
      }
      if (row.valid) setStatus('valid')
      else if (row.reason === 'expired') setStatus('expired')
      else if (row.reason === 'used_up') setStatus('used_up')
      else setStatus('invalid')
    })()
    return () => {
      active = false
    }
  }, [token])

  // Already signed in — nothing to redeem.
  if (session) return <Navigate to="/" replace />

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const addr = email.trim().toLowerCase()
      // Authorize this email against the link before signing up.
      const { error: redeemErr } = await supabase.rpc('redeem_invite_link', {
        p_token: token,
        p_email: addr,
      })
      if (redeemErr) throw new Error(redeemErr.message)
      await signUp(addr, password, displayName || undefined)
      // If email confirmation is off, onAuthStateChange sets the session and
      // the <Navigate> above takes over. Otherwise, tell them to confirm.
      setNotice(
        'Account created! If email confirmation is required, check your inbox — then sign in.',
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong'
      if (/invite link/i.test(msg)) {
        // The link went invalid between the status check and submit.
        setStatus('invalid')
      } else if (/already registered|already been registered/i.test(msg)) {
        setError('That email already has an account. Try signing in instead.')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const invalidCopy: Record<string, string> = {
    invalid: 'This invite link is no longer valid. Ask whoever shared it for a fresh one.',
    expired: 'This invite link has expired. Ask whoever shared it for a fresh one.',
    used_up: 'This invite link has reached its limit. Ask whoever shared it for a fresh one.',
  }

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-primary-soft via-bg to-bg p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-xl font-bold text-white">
            ✺
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">
            You&apos;re invited
          </h1>
          <p className="mt-1 text-sm text-muted">
            Create your account to join the workspace.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          {status === 'checking' && (
            <p className="py-6 text-center text-sm text-muted">Checking your invite…</p>
          )}

          {(status === 'invalid' || status === 'expired' || status === 'used_up') && (
            <div className="space-y-4 text-center">
              <p className="rounded-lg bg-red-50 px-3 py-3 text-sm text-red-600">
                {invalidCopy[status]}
              </p>
              <Link
                to="/login"
                className="inline-block text-sm font-medium text-primary hover:underline"
              >
                Go to sign in
              </Link>
            </div>
          )}

          {status === 'valid' && (
            <form onSubmit={handleSubmit} className="space-y-3">
              <Field
                label="Display name"
                type="text"
                value={displayName}
                onChange={setDisplayName}
                placeholder="Ada Lovelace"
                autoComplete="name"
              />
              <Field
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="you@company.com"
                autoComplete="email"
                required
              />
              <Field
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                placeholder="••••••••"
                autoComplete="new-password"
                required
              />

              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
              )}
              {notice && (
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  {notice}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-strong disabled:opacity-60"
              >
                {busy ? 'Working…' : 'Create account'}
              </button>

              <p className="pt-1 text-center text-xs text-faint">
                Already have an account?{' '}
                <Link to="/login" className="font-medium text-primary hover:underline">
                  Sign in
                </Link>
              </p>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-faint">Powered by Supabase Auth</p>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string
  value: string
  onChange: (v: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border-strong px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary-soft"
      />
    </label>
  )
}
