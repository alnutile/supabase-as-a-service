// Preflight: validate every credential in .env with cheap READ-ONLY calls
// before tenant-zero spends real money. Run: npm run preflight

import { env, requireEnv } from './env.ts'

type Check = { name: string; run: () => Promise<string> }

const checks: Check[] = [
  {
    name: 'Supabase Management PAT + org',
    run: async () => {
      const pat = requireEnv('SUPANET_MGMT_PAT')
      const orgId = requireEnv('SUPANET_ORG_ID')
      const res = await fetch('https://api.supabase.com/v1/organizations', {
        headers: { Authorization: `Bearer ${pat}` },
      })
      if (!res.ok) throw new Error(`PAT rejected (${res.status})`)
      const orgs = (await res.json()) as Array<{ id: string; name: string }>
      const hit = orgs.find((o) => o.id === orgId)
      if (!hit) {
        throw new Error(
          `org "${orgId}" not found; PAT sees: ${orgs.map((o) => `${o.name}=${o.id}`).join(', ') || '(none)'}`,
        )
      }
      return `org "${hit.name}" (${hit.id})`
    },
  },
  {
    name: 'Railway token + project + environment',
    run: async () => {
      const token = requireEnv('RAILWAY_TOKEN')
      const projectId = requireEnv('RAILWAY_PROJECT_ID')
      const environmentId = requireEnv('RAILWAY_ENVIRONMENT_ID')
      const res = await fetch('https://backboard.railway.com/graphql/v2', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query ($id: String!) { project(id: $id) { name environments { edges { node { id name } } } } }`,
          variables: { id: projectId },
        }),
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || json.errors?.length) {
        throw new Error(`token/project rejected: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`)
      }
      const proj = json.data?.project
      const envs: Array<{ id: string; name: string }> = (proj?.environments?.edges ?? []).map((e: any) => e.node)
      const hit = envs.find((e) => e.id === environmentId)
      if (!hit) {
        throw new Error(
          `environment "${environmentId}" not in project "${proj?.name}"; has: ${envs.map((e) => `${e.name}=${e.id}`).join(', ')}`,
        )
      }
      return `project "${proj.name}", environment "${hit.name}"`
    },
  },
  {
    name: 'Cloudflare token + zone',
    run: async () => {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${requireEnv('CLOUDFLARE_ZONE_ID')}`, {
        headers: { Authorization: `Bearer ${requireEnv('CLOUDFLARE_API_TOKEN')}` },
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || json?.success === false) {
        throw new Error(`rejected: ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`)
      }
      const zoneName = json?.result?.name
      const expected = env('TENANT_DOMAIN') ?? 'supanet.io'
      if (zoneName !== expected) throw new Error(`zone is "${zoneName}", expected "${expected}"`)
      return `zone "${zoneName}"`
    },
  },
  {
    name: 'OpenRouter provisioning key',
    run: async () => {
      const res = await fetch('https://openrouter.ai/api/v1/keys', {
        headers: { Authorization: `Bearer ${requireEnv('OPENROUTER_PROVISIONING_KEY')}` },
      })
      if (!res.ok) throw new Error(`rejected (${res.status})`)
      const json = (await res.json().catch(() => ({}))) as any
      const count = Array.isArray(json?.data) ? json.data.length : '?'
      return `ok (${count} existing runtime keys)`
    },
  },
  {
    name: 'GitHub release branch',
    run: async () => {
      const repo = requireEnv('TENANT_REPO')
      const branch = env('RELEASE_BRANCH') ?? 'release'
      const res = await fetch(`https://api.github.com/repos/${repo}/branches/${branch}`, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (res.status === 404) throw new Error(`branch "${branch}" not found on ${repo} (private repo? push it first)`)
      if (!res.ok) return `could not verify (${res.status}) — private repo is fine if the branch exists`
      return `${repo}@${branch} exists`
    },
  },
]

let failed = 0
for (const c of checks) {
  try {
    const detail = await c.run()
    console.log(`✓ ${c.name}: ${detail}`)
  } catch (err) {
    failed++
    console.error(`✗ ${c.name}: ${err instanceof Error ? err.message : err}`)
  }
}
if (failed) {
  console.error(`\n${failed} check(s) failed — fix .env and re-run: npm run preflight`)
  process.exit(1)
}
console.log('\nAll preflight checks passed. Ready for: npm run tenant-zero -- --slug <slug> --name "<Name>" --email <you>')
