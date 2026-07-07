import { AdminGate, SettingsShell, useIsAdmin } from './shell'
import { InvitePeople } from './cards'

export default function InviteSettings() {
  const { isAdmin, loading } = useIsAdmin()
  if (loading) return null
  if (!isAdmin) return <AdminGate message="Invites are managed by workspace admins." />
  return (
    <SettingsShell title="Invite people" subtitle="This workspace is invite-only.">
      <InvitePeople />
    </SettingsShell>
  )
}
