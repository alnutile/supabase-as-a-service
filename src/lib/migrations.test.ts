import { describe, expect, it } from 'vitest'

// Guard against the duplicate-migration-prefix bug that has repeatedly broken
// `supabase db push` on main (0056, 0058, 0059, 0060, 0065, 0078, 0081…).
// `db push` derives a migration's version from its numeric filename prefix, so
// two files sharing a prefix collide on the `schema_migrations` primary key and
// abort the ENTIRE push — every later migration then silently fails to deploy.
// A gap in the sequence is flagged too: the repo follows a strict "next free
// number" discipline, so a hole usually means a lost or misnumbered file.
//
// import.meta.glob (non-eager) yields just the file paths at build time — the
// same mechanism functionSources.ts uses to enumerate edge-function source, so
// no filesystem access is needed and it works under vitest/jsdom.
const files = Object.keys(import.meta.glob('../../supabase/migrations/*.sql'))

function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

function prefixOf(path: string): string {
  const name = nameOf(path)
  const m = name.match(/^(\d+)_/)
  if (!m) throw new Error(`Migration "${name}" is missing a leading NNNN_ numeric prefix`)
  return m[1]
}

describe('migration filenames', () => {
  it('finds migration files', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('has a unique numeric prefix per migration', () => {
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const path of files) {
      const prefix = prefixOf(path)
      const name = nameOf(path)
      const prior = seen.get(prefix)
      if (prior) dupes.push(`${prefix}: ${prior} & ${name}`)
      else seen.set(prefix, name)
    }
    expect(
      dupes,
      `Duplicate migration prefixes abort \`supabase db push\`:\n${dupes.join('\n')}`,
    ).toEqual([])
  })

  it('has contiguous, gap-free numeric prefixes', () => {
    const nums = [...new Set(files.map((f) => Number(prefixOf(f))))].sort((a, b) => a - b)
    const gaps: string[] = []
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] !== nums[i - 1] + 1) gaps.push(`gap between ${nums[i - 1]} and ${nums[i]}`)
    }
    expect(gaps, `Migration numbers must be contiguous:\n${gaps.join('\n')}`).toEqual([])
  })
})
