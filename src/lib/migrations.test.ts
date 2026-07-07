import { describe, expect, it } from 'vitest'

// `supabase db push` derives a migration's version from its numeric filename
// prefix, so two files sharing a prefix (e.g. two `0060_*.sql`) collide and the
// whole push is rejected — every pending migration silently fails to deploy.
// That once left the artifact share-password RPC undeployed, so clicking "Save
// password" in the Sharing panel errored (issue #114). Guard the invariant here.
//
// Uses Vite's `import.meta.glob` (as in lib/functionSources.ts) to enumerate the
// migration filenames at build time — no node:fs, so it typechecks under the
// app's DOM-only tsconfig.
const files = import.meta.glob('../../supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
})

function migrationPrefixes(): number[] {
  return Object.keys(files)
    .map((path) => {
      const name = path.split('/').pop() ?? path
      const m = /^(\d+)_/.exec(name)
      if (!m) throw new Error(`Migration "${name}" has no numeric prefix`)
      return Number(m[1])
    })
    .sort((a, b) => a - b)
}

describe('supabase migrations', () => {
  it('has a unique numeric prefix per file', () => {
    const prefixes = migrationPrefixes()
    const dupes = prefixes.filter((n, i) => prefixes.indexOf(n) !== i)
    expect(dupes).toEqual([])
  })

  it('has contiguous prefixes with no gaps', () => {
    const prefixes = migrationPrefixes()
    for (let i = 1; i < prefixes.length; i++) {
      expect(prefixes[i]).toBe(prefixes[i - 1] + 1)
    }
  })
})
