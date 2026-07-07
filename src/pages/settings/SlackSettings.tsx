import { AdminGate, SettingsShell, useIsAdmin } from './shell'
import { SlackCard } from './cards'

export default function SlackSettings() {
  const { isAdmin, loading } = useIsAdmin()
  if (loading) return null
  if (!isAdmin) return <AdminGate message="Slack is connected by workspace admins." />
  return (
    <SettingsShell title="Slack" subtitle="Bind Slack channels to collections so @mentions get answered.">
      <SlackCard />
    </SettingsShell>
  )
}
