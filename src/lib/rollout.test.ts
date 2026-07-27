import { describe, expect, it } from 'vitest'
import { migrationName, migrationVersion, pendingMigrations } from './rollout'

describe('rollout migration helpers', () => {
  it('parses version and name from a path or bare filename', () => {
    expect(migrationVersion('supabase/migrations/0093_table_events.sql')).toBe('0093')
    expect(migrationVersion('0001_init.sql')).toBe('0001')
    expect(migrationName('supabase/migrations/0093_table_events.sql')).toBe('table_events')
    expect(migrationName('0094_automation_cron.sql')).toBe('automation_cron')
  })

  it('throws on a file missing the NNNN_ prefix', () => {
    expect(() => migrationVersion('weird.sql')).toThrow()
  })

  it('returns only pending migrations, ascending, skipping applied', () => {
    const paths = ['a/0002_b.sql', 'a/0001_a.sql', 'a/0003_c.sql', 'a/0010_j.sql']
    const pend = pendingMigrations(paths, ['0001', '0003'])
    expect(pend.map((m) => m.version)).toEqual(['0002', '0010'])
  })

  it('sorts numerically, not lexically', () => {
    const paths = ['a/0010_j.sql', 'a/0002_b.sql']
    expect(pendingMigrations(paths, []).map((m) => m.version)).toEqual(['0002', '0010'])
  })

  it('is empty when everything is applied', () => {
    expect(pendingMigrations(['0001_a.sql', '0002_b.sql'], ['0001', '0002'])).toEqual([])
  })

  it('coerces non-string applied versions', () => {
    expect(pendingMigrations(['0001_a.sql'], [1 as unknown as string]).length).toBe(1)
    expect(pendingMigrations(['0001_a.sql'], ['0001']).length).toBe(0)
  })
})
