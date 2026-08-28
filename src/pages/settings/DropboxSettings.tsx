import { AdminGate, SettingsShell, useIsAdmin } from './shell'
import { DropboxCard } from './cards'

export default function DropboxSettings() {
  const { isAdmin, loading } = useIsAdmin()
  if (loading) return null
  if (!isAdmin) return <AdminGate message="Dropbox is configured by workspace admins." />
  return (
    <SettingsShell
      title="Dropbox"
      subtitle="Connect your Dropbox account to enrich links with file metadata and enable file ingestion."
    >
      <DropboxCard />
    </SettingsShell>
  )
}
