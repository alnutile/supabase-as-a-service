import { SettingsShell } from './shell'
import { AboutCard, InstallAppCard, PasswordCard, ProfileCard } from './cards'

export default function ProfileSettings() {
  return (
    <SettingsShell title="Profile" subtitle="Manage your profile and account.">
      <ProfileCard />
      <PasswordCard />
      <InstallAppCard />
      <AboutCard />
    </SettingsShell>
  )
}
