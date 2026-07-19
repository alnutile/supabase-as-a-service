// Tenant zero: run the full provisioning pipeline from a laptop, before any
// control-plane backend exists. Proves the API choreography end to end.
//
//   cd control-plane && npm install
//   cp .env.example .env   # fill in credentials
//   npm run tenant-zero -- --slug acme --name "Acme Co" --email you@example.com
//
// Progress persists to tenant-zero.state.json (gitignored); re-running the same
// slug resumes at the failed step. Delete the state file to start over.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPipeline } from './pipeline.ts'
import { buildSteps } from './steps.ts'
import type { StepRecord, TenantState } from './types.ts'

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'tenant-zero.state.json')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const slug = arg('slug')
const name = arg('name') ?? slug
const email = arg('email')
if (!slug || !email || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) {
  console.error('Usage: npm run tenant-zero -- --slug acme --name "Acme Co" --email you@example.com')
  console.error('       (slug: lowercase letters/digits/hyphens, 2-31 chars)')
  process.exit(1)
}

interface Saved {
  slug: string
  state: TenantState
  steps: StepRecord[]
}
let saved: Saved | null = null
try {
  const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Saved
  if (parsed.slug === slug) {
    saved = parsed
    console.log(`Resuming ${slug} (completed: ${parsed.steps.filter((s) => s.status === 'ok').map((s) => s.name).join(', ') || 'none'})`)
  }
} catch {
  // fresh run
}

const result = await runPipeline({
  spec: { slug, name: name!, adminEmail: email },
  steps: buildSteps(),
  completed: saved?.steps.filter((s) => s.status === 'ok').map((s) => s.name),
  initialState: saved?.state,
  log: (m) => console.log(m),
  persist: ({ state, steps }) => {
    const prior = saved?.steps.filter((s) => s.status === 'ok' && !steps.some((n) => n.name === s.name)) ?? []
    writeFileSync(STATE_FILE, JSON.stringify({ slug, state, steps: [...prior, ...steps] }, null, 2))
  },
})

if (result.ok) {
  console.log(`\n🎉 Tenant "${slug}" is live: ${result.state.appUrl}`)
  console.log(`   First sign-in becomes admin — use ${email}.`)
} else {
  console.error(`\nProvisioning stopped at "${result.failedStep}". Fix the cause and re-run the same command to resume.`)
  process.exit(1)
}
