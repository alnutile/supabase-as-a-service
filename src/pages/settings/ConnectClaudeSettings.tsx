import { SettingsShell } from './shell'
import { ConnectClaude } from './cards'

export default function ConnectClaudeSettings() {
  return (
    <SettingsShell
      title="Connect Claude"
      subtitle="Connect Claude Code to this workspace over MCP with a personal token."
    >
      <ConnectClaude />
    </SettingsShell>
  )
}
