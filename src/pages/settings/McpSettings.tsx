import { AdminGate, SettingsShell, useIsAdmin } from './shell'
import { McpCard } from './cards'

export default function McpSettings() {
  const { isAdmin, loading } = useIsAdmin()
  if (loading) return null
  if (!isAdmin) return <AdminGate message="External MCP servers are managed by workspace admins." />
  return (
    <SettingsShell
      title="External MCP"
      subtitle="Connect outbound MCP endpoints so agents can call their tools."
    >
      <McpCard />
    </SettingsShell>
  )
}
