import { AdminGate, SettingsShell, useIsAdmin } from './shell'
import { ModelsCard } from './cards'

export default function ModelsSettings() {
  const { isAdmin, loading } = useIsAdmin()
  if (loading) return null
  if (!isAdmin) return <AdminGate message="Models are managed by workspace admins." />
  return (
    <SettingsShell title="Models" subtitle="Which model powers each named job.">
      <ModelsCard />
    </SettingsShell>
  )
}
