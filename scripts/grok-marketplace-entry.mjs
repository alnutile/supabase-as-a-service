#!/usr/bin/env node
// Prints the catalog entry to paste into xai-org/plugin-marketplace's
// `.grok-plugin/marketplace.json`, with the commit SHA already pinned.
//
// The marketplace requires a full 40-char lowercase commit SHA on every remote
// source: an unpinned ref would let a later force-push ship new code to everyone
// who installs or updates. Grok Build re-verifies `git rev-parse HEAD == sha`
// after cloning, so the pin has to be a real commit that is public and reachable.
//
//   node scripts/grok-marketplace-entry.mjs                 # pin origin/main
//   node scripts/grok-marketplace-entry.mjs <sha|ref>       # pin something else
//
// See docs/grok-plugin.md for the full submission runbook.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REPO_URL = 'https://github.com/alnutile/supabase-as-a-service.git'
const PLUGIN_PATH = 'grok-plugin'

function resolveSha(ref) {
  // Ask the remote, not the local clone: the pinned commit must be one the
  // marketplace's CI can fetch. A local-only commit would pass here and fail there.
  if (/^[0-9a-f]{40}$/.test(ref)) return ref
  const out = execFileSync('git', ['ls-remote', REPO_URL, ref], { encoding: 'utf8' }).trim()
  const sha = out.split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new Error(`Could not resolve "${ref}" to a commit on ${REPO_URL}.\n` +
      `git ls-remote returned: ${JSON.stringify(out)}`)
  }
  return sha
}

const ref = process.argv[2] ?? 'refs/heads/main'
const sha = resolveSha(ref)

const manifest = JSON.parse(
  readFileSync(new URL(`../${PLUGIN_PATH}/.grok-plugin/plugin.json`, import.meta.url), 'utf8'),
)

const entry = {
  name: manifest.name,
  description: manifest.description,
  category: 'productivity',
  source: { source: 'url', url: REPO_URL, sha, path: PLUGIN_PATH },
  homepage: manifest.homepage,
  keywords: manifest.keywords,
  domains: ['supanet.io', 'supanet.dailyai.studio'],
  version: manifest.version,
  author: manifest.author?.name,
}

console.log(JSON.stringify(entry, null, 2))
console.error(`\n# pinned ${ref} -> ${sha}`)
