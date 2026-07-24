import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import {
  DEFAULT_TIMEZONE,
  allTimezones,
  detectBrowserTimezone,
  formatCurrentTime,
  isValidTimezone,
  utcOffsetLabel,
} from '../../lib/timezone'
import { AdminGate, SettingsShell, useIsAdmin } from './shell'

// Settings → Timezone. The workspace-wide clock the agentic automations
// (scheduler, event listeners, webhooks, Slack, chat, loops) treat as "local"
// when reasoning about the current date/time — and the default zone for new
// agent schedules. Stored as a single `workspace_settings` row (key='timezone').
// Without it every unattended run assumes UTC, which reads as the wrong time.
export default function TimezoneSettings() {
  const { user } = useAuth()
  const { isAdmin, loading: adminLoading } = useIsAdmin()
  const [saved, setSaved] = useState<string>(DEFAULT_TIMEZONE)
  const [choice, setChoice] = useState<string>(DEFAULT_TIMEZONE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Re-render the live clock previews every 30s so they stay honest.
  const [tick, setTick] = useState(0)

  const browserTz = useMemo(() => detectBrowserTimezone(), [])
  const zones = useMemo(() => allTimezones(), [])

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('workspace_settings')
      .select('value')
      .eq('key', 'timezone')
      .maybeSingle()
    const tz = data?.value && isValidTimezone(data.value) ? data.value : DEFAULT_TIMEZONE
    setSaved(tz)
    setChoice(tz)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  void tick

  async function save() {
    if (!user || choice === saved) return
    if (!isValidTimezone(choice)) {
      setError('That is not a recognized IANA timezone.')
      return
    }
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.from('workspace_settings').upsert({
      key: 'timezone',
      value: choice,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    if (err) setError(err.message)
    else setSaved(choice)
    setSaving(false)
  }

  if (adminLoading) return null
  if (!isAdmin) return <AdminGate message="The workspace timezone is managed by admins." />

  const now = new Date()
  const dirty = choice !== saved

  return (
    <SettingsShell
      title="Timezone"
      subtitle="The clock your automations run on. Scheduled agents, event listeners, webhooks, Slack replies, and chat all reason about “today” and “now” in this timezone — set it to where your team actually is so unattended runs stop assuming UTC."
    >
      {loading ? (
        <p className="mt-6 text-sm text-faint">Loading…</p>
      ) : (
        <div className="mt-6 space-y-5">
          {/* System / current state */}
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-faint">Current</h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Workspace timezone</dt>
                <dd className="text-right font-medium text-text">
                  {saved}
                  <span className="ml-2 text-xs font-normal text-faint">{utcOffsetLabel(saved, now)}</span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Time in your workspace now</dt>
                <dd className="text-right font-medium text-text">{formatCurrentTime(saved, now)}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
                <dt className="text-muted">
                  This device’s timezone
                  <span className="ml-2 text-xs text-faint">{browserTz}</span>
                </dt>
                <dd className="text-right">
                  {browserTz !== saved ? (
                    <button
                      onClick={() => setChoice(browserTz)}
                      className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text transition hover:bg-surface-hover"
                    >
                      Use this
                    </button>
                  ) : (
                    <span className="text-xs text-faint">matches workspace</span>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          {/* Picker */}
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-faint">Change timezone</h2>
            <label htmlFor="tz-select" className="mt-3 block text-sm font-medium text-text">
              Workspace timezone
            </label>
            <select
              id="tz-select"
              value={zones.includes(choice) ? choice : ''}
              onChange={(e) => setChoice(e.target.value)}
              className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text focus:border-primary focus:outline-none"
            >
              {!zones.includes(choice) && choice && (
                <option value="">{choice} (custom)</option>
              )}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z} — {utcOffsetLabel(z, now)}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-faint">
              Selected: <span className="font-medium text-muted">{formatCurrentTime(choice, now)}</span>
            </p>
            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={save}
                disabled={!dirty || saving}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save timezone'}
              </button>
              {dirty && !saving && (
                <button
                  onClick={() => setChoice(saved)}
                  className="text-sm text-muted transition hover:text-text"
                >
                  Cancel
                </button>
              )}
            </div>
          </section>

          <p className="text-xs text-faint">
            Existing schedules keep the timezone they were created with. New schedules default to this
            one, and every agent run is told the current date and time in this timezone.
          </p>
        </div>
      )}
    </SettingsShell>
  )
}
