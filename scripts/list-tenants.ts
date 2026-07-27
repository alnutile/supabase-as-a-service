/**
 * Resolve the tenant project refs the fan-out should update, and print them as a
 * compact JSON array to stdout (consumed by the release-tenants matrix).
 *
 * Source of truth: the CONTROL PLANE's `tenants` table (its own Supabase
 * project), queried via the Management API SQL endpoint with the org PAT — the
 * same way scripts/apply-migrations.ts talks to a tenant. Only LIVE tenants
 * (status active|past_due, with a project_ref) are returned, so paused /
 * provisioning / deleted projects are never touched.
 *
 * Optional override: if infra/tenants.json lists refs, those win — a canary /
 * manual subset (e.g. roll out to one tenant first). Set it back to [] to go
 * back to "all live tenants from the control plane".
 *
 *   SUPABASE_ACCESS_TOKEN=<pat> CONTROL_PLANE_REF=<ref> npx tsx scripts/list-tenants.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseTenantRefs } from '../src/lib/rollout'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function overrideRefs(): string[] | null {
  try {
    const j = JSON.parse(readFileSync(join(root, 'infra', 'tenants.json'), 'utf8'))
    const refs = parseTenantRefs((Array.isArray(j.refs) ? j.refs : []).map((project_ref: unknown) => ({
      project_ref: typeof project_ref === 'string' ? project_ref : null,
    })))
    return refs.length ? refs : null
  } catch {
    return null
  }
}

async function controlPlaneRefs(): Promise<string[]> {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  const cpRef = process.env.CONTROL_PLANE_REF
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN (org owner PAT) is required')
  if (!cpRef) throw new Error('CONTROL_PLANE_REF is required (the control-plane Supabase project ref)')
  const res = await fetch(`https://api.supabase.com/v1/projects/${cpRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query:
        "select project_ref from public.tenants" +
        " where status in ('active','past_due') and project_ref is not null" +
        ' order by created_at',
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`control-plane query failed (HTTP ${res.status}): ${text.slice(0, 500)}`)
  return parseTenantRefs(JSON.parse(text) as Array<{ project_ref?: string | null }>)
}

async function main() {
  const override = overrideRefs()
  const refs = override ?? (await controlPlaneRefs())
  console.error(
    override
      ? `[list-tenants] override: ${refs.length} ref(s) from infra/tenants.json`
      : `[list-tenants] ${refs.length} live tenant(s) from the control plane`,
  )
  process.stdout.write(JSON.stringify(refs))
}

main().catch((e) => {
  console.error(`[list-tenants] ERROR: ${(e as Error).message}`)
  process.exit(1)
})
