import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { flaggableGroups, isFeatureEnabled, type FlagMap, type NavItem } from '../../lib/nav'
import { AdminGate, SettingsShell, useIsAdmin } from './shell'

// Feature flags: hide/show sidebar areas workspace-wide (issue #122).
//
// This is feature HIDING, not permissions — turn an area off because the
// company doesn't use it (and doesn't want to confuse staff) or you're just
// trying something out. The flag only removes the sidebar link (and its ⌘K
// palette entry); RLS still protects the underlying data. Absence of a
// feature_flags row = enabled, so a fresh workspace shows everything.
export default function FeatureFlagsSettings() {
  const { user } = useAuth()
  const { isAdmin, loading: adminLoading } = useIsAdmin()
  const [flags, setFlags] = useState<FlagMap>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('feature_flags').select('key, enabled')
    const map: FlagMap = {}
    for (const row of data ?? []) map[row.key] = row.enabled
    setFlags(map)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const groups = flaggableGroups()

  async function toggle(item: NavItem) {
    if (!user) return
    const next = !isFeatureEnabled(item, flags)
    setBusy(item.key)
    // Optimistic; upsert keyed on `key`. enabled=true rows are kept (rather than
    // deleted) so the "who/when" columns record the last change either way.
    setFlags((f) => ({ ...f, [item.key]: next }))
    const { error } = await supabase.from('feature_flags').upsert({
      key: item.key,
      enabled: next,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    if (error) {
      // Roll back on failure.
      setFlags((f) => ({ ...f, [item.key]: !next }))
      alert(error.message)
    }
    setBusy(null)
  }

  if (adminLoading) return null
  if (!isAdmin) return <AdminGate message="Feature flags are managed by workspace admins." />

  const hiddenCount = groups
    .flatMap((g) => g.items)
    .filter((i) => !isFeatureEnabled(i, flags)).length

  return (
    <SettingsShell
      title="Feature flags"
      subtitle="Turn sidebar areas on or off for the whole workspace. This hides features — it isn't a permission or a security control; row-level security still protects the underlying data."
    >
      {loading ? (
        <p className="mt-6 text-sm text-faint">Loading…</p>
      ) : (
        <>
          <p className="mt-4 text-xs text-faint">
            {hiddenCount === 0
              ? 'Everything is on. Toggle anything off to hide it from the sidebar and search.'
              : `${hiddenCount} area${hiddenCount === 1 ? '' : 's'} hidden. Home, Chat and Settings can't be hidden.`}
          </p>
          <div className="mt-4 space-y-6">
            {groups.map((group) => (
              <section key={group.label} className="rounded-xl border border-border bg-surface p-5">
                <h2 className="text-[11px] font-bold uppercase tracking-wider text-faint">{group.label}</h2>
                <div className="mt-3 space-y-1">
                  {group.items.map((item) => {
                    const enabled = isFeatureEnabled(item, flags)
                    const Icon = item.icon
                    return (
                      <div
                        key={item.key}
                        className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-surface-hover"
                      >
                        <Icon className={`h-5 w-5 shrink-0 ${enabled ? 'text-muted' : 'text-faint'}`} />
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-medium ${enabled ? 'text-text' : 'text-faint'}`}>
                            {item.label}
                            {item.adminOnly && (
                              <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-faint">
                                admin only
                              </span>
                            )}
                          </p>
                          <p className="truncate text-[11px] text-faint">{item.to}</p>
                        </div>
                        <button
                          onClick={() => toggle(item)}
                          disabled={busy === item.key}
                          title={enabled ? 'Enabled — click to hide' : 'Hidden — click to show'}
                          aria-pressed={enabled}
                          className={`relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 ${
                            enabled ? 'bg-primary' : 'bg-border-strong'
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface transition ${
                              enabled ? 'left-[18px]' : 'left-0.5'
                            }`}
                          />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </SettingsShell>
  )
}
