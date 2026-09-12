import { AdminGate, SettingsShell, useIsAdmin } from './shell'
import { GitHubCard } from './cards'

export default function GitHubSettings() {
  const { isAdmin, loading } = useIsAdmin()
  if (loading) return null
  if (!isAdmin) return <AdminGate message="GitHub is configured by workspace admins." />
  return (
    <SettingsShell
      title="GitHub"
      subtitle="A workspace token lets Repositories read private GitHub repos and lifts the anonymous rate limit."
    >
      <GitHubCard />
    </SettingsShell>
  )
}
