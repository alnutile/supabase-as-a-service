// Loads the deployable assets — migrations + edge functions — from a repo
// checkout on disk (Node runs: tenant-zero CLI, CI). The control plane's edge
// functions will need these bundled at build time instead (the same move as
// src/lib/functionSources.ts `import.meta.glob('?raw')`) — keep this module's
// OUTPUT shapes identical so that swap is trivial.
//
// File-name/entrypoint contract copied from src/lib/functionSources.ts (the
// proven deploy_core path): names are repo-relative like
// "functions/chat/index.ts" + all of "functions/_shared/*" appended to every
// function (the bundler only pulls what the entrypoint imports).

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DeployFile } from './supabaseApi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SUPABASE_DIR = join(REPO_ROOT, 'supabase')

export interface Migration {
  version: string // numeric prefix, e.g. "0001"
  name: string // filename without .sql
  sql: string
}

export function loadMigrations(): Migration[] {
  const dir = join(SUPABASE_DIR, 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({
      version: f.split('_')[0],
      name: f.replace(/\.sql$/, ''),
      sql: readFileSync(join(dir, f), 'utf8'),
    }))
}

export interface FunctionBundle {
  slug: string
  entrypointPath: string
  verifyJwt: boolean
  files: DeployFile[]
}

/** Parse verify_jwt flags out of supabase/config.toml ([functions.<slug>] blocks). */
export function loadVerifyJwtMap(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  let current: string | null = null
  const toml = readFileSync(join(SUPABASE_DIR, 'config.toml'), 'utf8')
  for (const line of toml.split('\n')) {
    const section = line.match(/^\s*\[functions\.([A-Za-z0-9_-]+)\]/)
    if (section) {
      current = section[1]
      continue
    }
    if (/^\s*\[/.test(line)) current = null
    const flag = line.match(/^\s*verify_jwt\s*=\s*(true|false)/)
    if (current && flag) out[current] = flag[1] === 'true'
  }
  return out
}

export function loadFunctionBundles(): FunctionBundle[] {
  const fnDir = join(SUPABASE_DIR, 'functions')
  const verifyJwt = loadVerifyJwtMap()

  const readDirFiles = (slug: string): DeployFile[] =>
    readdirSync(join(fnDir, slug))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ name: `functions/${slug}/${f}`, content: readFileSync(join(fnDir, slug, f), 'utf8') }))

  const shared = readDirFiles('_shared')
  const out: FunctionBundle[] = []
  for (const slug of readdirSync(fnDir)) {
    if (slug === '_shared' || slug === 'tests') continue
    let files: DeployFile[]
    try {
      files = readDirFiles(slug)
    } catch {
      continue // not a directory
    }
    if (!files.some((f) => f.name === `functions/${slug}/index.ts`)) continue
    out.push({
      slug,
      entrypointPath: `functions/${slug}/index.ts`,
      // Same default as functionSources.ts: verify unless config.toml says otherwise.
      verifyJwt: verifyJwt[slug] ?? true,
      files: [...files, ...shared],
    })
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}
