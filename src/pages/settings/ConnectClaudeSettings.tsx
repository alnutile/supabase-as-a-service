import { SettingsShell } from './shell'
import { ConnectClaude } from './cards'

export default function ConnectClaudeSettings() {
  return (
    <SettingsShell
      title="Connect Claude"
      subtitle="Connect Claude Desktop, claude.ai, or Claude Code to this workspace over MCP — sign in with one click, or use a personal token."
    >
      <ConnectClaude />
    </SettingsShell>
  )
}
