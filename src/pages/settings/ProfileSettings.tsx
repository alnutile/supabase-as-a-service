import { SettingsShell } from './shell'
import { AboutCard, ProfileCard } from './cards'

export default function ProfileSettings() {
  return (
    <SettingsShell title="Profile" subtitle="Manage your profile and account.">
      <ProfileCard />
      <AboutCard />
    </SettingsShell>
  )
}
