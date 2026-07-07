import { AdminGate, SettingsShell, useIsAdmin } from './shell'
import { EmailCard } from './cards'

export default function EmailSettings() {
  const { isAdmin, loading } = useIsAdmin()
  if (loading) return null
  if (!isAdmin) return <AdminGate message="Email is configured by workspace admins." />
  return (
    <SettingsShell title="Email" subtitle="Send and receive mail from the assistant and agents.">
      <EmailCard />
    </SettingsShell>
  )
}
