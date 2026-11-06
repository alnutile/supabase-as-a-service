#!/usr/bin/env node
// npm run dev:local — run the app against the local second brain (SQLite) with
// no Supabase: starts the Bun server (local/server.ts) and the Vite dev server
// in local mode, both bound to 127.0.0.1, and stops both on Ctrl-C.
//
// Env passthrough: BRAIN_DB (database file), BRAIN_PORT (default 8787).
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

if (spawnSync('bun', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('Bun is required for the local server. Install it with:\n\n  brew install oven-sh/bun/bun\n')
  process.exit(1)
}

const env = { ...process.env, VITE_BACKEND: 'local' }
// Run Vite's own entry with this Node (not through npx, whose extra shell
// would leave Vite orphaned when we stop). Bind to loopback only: the hosted
// dev server listens on the LAN, the brain must not. --strictPort fails loudly
// instead of drifting to another port if 5173 is taken.
const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js')
const children = [
  spawn('bun', ['local/server.ts'], { stdio: 'inherit', env }),
  spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--strictPort'], { stdio: 'inherit', env }),
]

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) c.kill('SIGTERM')
  process.exit(code)
}
for (const c of children) c.on('exit', (code) => stop(code ?? 0))
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
