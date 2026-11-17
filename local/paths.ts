// Where the local brain keeps its database. Override with BRAIN_DB.
//   macOS:  ~/Library/Application Support/SecondBrain/brain.db
//   other:  $XDG_DATA_HOME/second-brain/brain.db (default ~/.local/share/...)
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export function defaultDbPath(env: Record<string, string | undefined> = process.env): string {
  if (env.BRAIN_DB) return env.BRAIN_DB
  const home = homedir()
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'SecondBrain', 'brain.db')
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'second-brain', 'brain.db')
}
