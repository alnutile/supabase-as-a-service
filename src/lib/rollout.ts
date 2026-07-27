// Pure helpers for the tenant fan-out (scripts/apply-migrations.ts). Kept
// dependency-free so the same logic is unit-tested here and used by the script.
//
// A migration's *version* is its numeric filename prefix (e.g. `0093`) — the
// exact key `supabase db push` records in supabase_migrations.schema_migrations,
// so the two paths (db push on the origin project, this fan-out on tenants) agree
// on what's already applied and never double-run a migration.

export function migrationVersion(pathOrName: string): string {
  const base = pathOrName.split('/').pop() ?? pathOrName
  const m = base.match(/^(\d+)_/)
  if (!m) throw new Error(`Migration "${base}" is missing a leading NNNN_ prefix`)
  return m[1]
}

export function migrationName(pathOrName: string): string {
  const base = pathOrName.split('/').pop() ?? pathOrName
  return base.replace(/^\d+_/, '').replace(/\.sql$/, '')
}

export interface MigrationFile {
  path: string
  version: string
  name: string
}

// Given all migration file paths and the versions already applied on a target
// database, return the ones still pending, in ascending version order.
export function pendingMigrations(paths: string[], applied: Iterable<string>): MigrationFile[] {
  const appliedSet = new Set([...applied].map((v) => String(v)))
  return paths
    .map((p) => ({ path: p, version: migrationVersion(p), name: migrationName(p) }))
    .filter((m) => !appliedSet.has(m.version))
    .sort((a, b) => Number(a.version) - Number(b.version))
}
