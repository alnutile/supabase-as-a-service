// Env loading for Node runs (tenant-zero CLI). Reads control-plane/.env if
// present (no dotenv dependency), then process.env. Edge-function runs skip this
// file entirely and pass config explicitly.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

let loaded = false
function loadDotEnv(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = readFileSync(join(HERE, '..', '.env'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (!m || line.trim().startsWith('#')) continue
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // no .env — rely on process.env
  }
}

export function env(name: string): string | undefined {
  loadDotEnv()
  return process.env[name] || undefined
}

export function requireEnv(name: string): string {
  const v = env(name)
  if (!v) throw new Error(`Missing required env var ${name} (see control-plane/.env.example)`)
  return v
}
