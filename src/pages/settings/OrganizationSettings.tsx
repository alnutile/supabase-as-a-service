import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { AdminGate, SettingsShell, useIsAdmin } from './shell'

// Settings → Organization. The workspace-wide organization name that appears on
// the home page greeting so users instantly know which workspace they're using.
// Stored as a single `workspace_settings` row (key='organization_name').
export default function OrganizationSettings() {
  const { user } = useAuth()
  const { isAdmin, loading: adminLoading } = useIsAdmin()
  const [saved, setSaved] = useState<string>('')
  const [value, setValue] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('workspace_settings')
      .select('value')
      .eq('key', 'organization_name')
      .maybeSingle()
    const orgName = data?.value ?? ''
    setSaved(orgName)
    setValue(orgName)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    if (!user || value === saved) return
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.from('workspace_settings').upsert({
      key: 'organization_name',
      value: value.trim(),
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    if (err) setError(err.message)
    else setSaved(value.trim())
    setSaving(false)
  }

  if (adminLoading) return null
  if (!isAdmin) return <AdminGate message="The organization name is managed by admins." />

  const dirty = value !== saved

  return (
    <SettingsShell
      title="Organization"
      subtitle="Set your organization name to help everyone know which workspace they're using at a glance."
    >
      {loading ? (
        <p className="mt-6 text-sm text-faint">Loading…</p>
      ) : (
        <div className="mt-6 space-y-5">
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-faint">
              Organization Name
            </h2>
            <div className="mt-3 space-y-3">
              <div>
                <label htmlFor="org-name" className="block text-sm font-medium text-text">
                  Name
                </label>
                <input
                  id="org-name"
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="e.g., Acme Corp, Engineering Team, etc."
                  className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-faint focus:border-primary focus:outline-none"
                  maxLength={100}
                />
                <p className="mt-2 text-xs text-faint">
                  {value.trim()
                    ? `This will appear on the home page: "Good morning, ${value.trim()}"`
                    : 'Leave blank to show only the user greeting'}
                </p>
              </div>
              {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
              <div className="mt-4 flex items-center gap-3">
                <button
                  onClick={save}
                  disabled={!dirty || saving}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {dirty && !saving && (
                  <button
                    onClick={() => setValue(saved)}
                    className="text-sm text-muted transition hover:text-text"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </section>

          <p className="text-xs text-faint">
            The organization name appears on the home page greeting to help users identify which
            Supanet workspace they're currently using.
          </p>
        </div>
      )}
    </SettingsShell>
  )
}
