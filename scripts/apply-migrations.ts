/**
 * Apply pending migrations to ONE tenant Supabase project via the Management API
 * SQL endpoint — no DB password, just the org PAT (SUPABASE_ACCESS_TOKEN), which
 * reaches every project in your Supabase org. Used by the release-tenants
 * fan-out. Idempotent: skips anything already recorded in
 * supabase_migrations.schema_migrations (same tracking as `supabase db push`),
 * so re-running is a no-op. After migrations it schedules the automation cron
 * (via the setup_automation_cron RPC that ships in 0094) so the tenant's
 * dispatcher/scheduler are wired too.
 *
 *   SUPABASE_ACCESS_TOKEN=<pat> npx tsx scripts/apply-migrations.ts <project-ref> [--dry-run]
 *
 * Assumes the tenant was initialised with `supabase db push` (so schema_migrations
 * reflects reality). A project whose objects exist but whose history is empty
 * would try to re-apply from 0001 and fail loudly for THAT tenant only — the
 * fan-out uses fail-fast:false, so one bad tenant never blocks the rest.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pendingMigrations } from '../src/lib/rollout'

const ref = process.argv[2]
const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'
const token = process.env.SUPABASE_ACCESS_TOKEN

if (!ref) {
  console.error('Usage: apply-migrations.ts <project-ref> [--dry-run]')
  process.exit(2)
}
if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN (org owner PAT) is required')
  process.exit(2)
}

const QUERY_URL = `https://api.supabase.com/v1/projects/${ref}/database/query`

async function runSql(query: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(QUERY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`SQL query failed (HTTP ${res.status}): ${text.slice(0, 800)}`)
  try {
    return JSON.parse(text)
  } catch {
    return []
  }
}

const sqlLit = (s: string) => `'${s.replace(/'/g, "''")}'`

const migDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => join(migDir, f))

async function main() {
  // Ensure the history table exists (Supabase's shape), then read applied versions.
  await runSql(
    `create schema if not exists supabase_migrations;
     create table if not exists supabase_migrations.schema_migrations (
       version text primary key, statements text[], name text);`,
  )
  const rows = await runSql('select version from supabase_migrations.schema_migrations')
  const applied = rows.map((r) => String(r.version))
  const pending = pendingMigrations(files, applied)

  console.log(`[${ref}] ${applied.length} applied · ${pending.length} pending`)
  for (const m of pending) console.log(`[${ref}]   pending ${m.version}_${m.name}`)

  if (dryRun) {
    console.log(`[${ref}] dry-run — nothing applied`)
    return
  }

  for (const m of pending) {
    const sql = readFileSync(m.path, 'utf8')
    console.log(`[${ref}] applying ${m.version}_${m.name}…`)
    // Migration + its history row in ONE transaction (matches db push), so a
    // failure leaves nothing half-applied-but-untracked. The `\n;\n` guards
    // against a migration whose final statement lacks a trailing semicolon.
    await runSql(
      `begin;\n${sql}\n;\ninsert into supabase_migrations.schema_migrations (version, name)` +
        ` values (${sqlLit(m.version)}, ${sqlLit(m.name)}) on conflict (version) do nothing;\ncommit;`,
    )
    console.log(`[${ref}]   applied ${m.version}`)
  }

  // Schedule the tenant's automation cron (function exists as of 0094). Runs as
  // the postgres role via /database/query → auth.uid() is null → allowed.
  try {
    await runSql(`select public.setup_automation_cron('https://${ref}.supabase.co')`)
    console.log(`[${ref}] automation cron scheduled`)
  } catch (e) {
    console.log(`[${ref}] cron scheduling skipped: ${(e as Error).message}`)
  }

  console.log(`[${ref}] done — ${pending.length} migration(s) applied`)
}

main().catch((e) => {
  console.error(`[${ref}] ERROR: ${(e as Error).message}`)
  process.exit(1)
})
