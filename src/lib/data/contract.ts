// The behaviour every data backend must have, written once as a vitest suite.
// Run it against each backend (memory now, the local SQLite one next) so the
// hosted and local builds can't drift apart in what the pages see.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Backend } from './stores'

export function runBackendContract(name: string, makeBackend: () => Backend | Promise<Backend>) {
  describe(`data backend contract: ${name}`, () => {
    let b: Backend
    beforeEach(async () => {
      b = await makeBackend()
    })

    describe('terminology', () => {
      it('creates, reads, lists sorted, updates and removes a term', async () => {
        const zeta = await b.terminology.create({ term: 'Zeta', definition: 'last' })
        const alpha = await b.terminology.create({ term: 'alpha', definition: 'first', notes: 'n' })
        expect(alpha.id).toBeTruthy()
        expect(alpha.notes).toBe('n')
        expect(zeta.notes).toBe('')

        expect((await b.terminology.list()).map((t) => t.term)).toEqual(['alpha', 'Zeta'])
        expect((await b.terminology.get(alpha.id))?.definition).toBe('first')

        await b.terminology.update(alpha.id, { definition: 'changed' })
        expect((await b.terminology.get(alpha.id))?.definition).toBe('changed')

        await b.terminology.remove(alpha.id)
        expect(await b.terminology.get(alpha.id)).toBeNull()
        expect((await b.terminology.list()).map((t) => t.id)).toEqual([zeta.id])
      })

      it('returns null for an unknown id', async () => {
        expect(await b.terminology.get('does-not-exist')).toBeNull()
      })
    })

    describe('collections', () => {
      it('creates collections and lists them by name', async () => {
        await b.collections.create({ name: 'Work' })
        await b.collections.create({ name: 'Home' })
        const names = (await b.collections.list()).map((c) => c.name)
        expect(names).toEqual(expect.arrayContaining(['Home', 'Work']))
        expect(names.indexOf('Home')).toBeLessThan(names.indexOf('Work'))
      })

      it('files items in and out of a collection, per kind', async () => {
        const c = await b.collections.create({ name: 'Glossary' })
        const t1 = await b.terminology.create({ term: 'a', definition: 'a' })
        const t2 = await b.terminology.create({ term: 'b', definition: 'b' })

        await b.collections.addItems('term', c.id, [t1.id, t2.id])
        await b.collections.addItems('term', c.id, [t1.id]) // twice is a no-op
        const all = await b.collections.memberships('term')
        expect(all.filter((m) => m.collectionId === c.id).map((m) => m.itemId).sort()).toEqual(
          [t1.id, t2.id].sort(),
        )

        // Filtering by item id, and kinds don't leak into each other.
        expect(await b.collections.memberships('term', [t2.id])).toEqual([{ collectionId: c.id, itemId: t2.id }])
        expect(await b.collections.memberships('term', [])).toEqual([])
        expect(await b.collections.memberships('link')).toEqual([])

        await b.collections.removeItems('term', c.id, [t1.id])
        expect((await b.collections.memberships('term')).map((m) => m.itemId)).toEqual([t2.id])
      })

      it('drops a term from its collections when the term is removed', async () => {
        const c = await b.collections.create({ name: 'G' })
        const t = await b.terminology.create({ term: 'gone', definition: 'x' })
        await b.collections.addItems('term', c.id, [t.id])
        await b.terminology.remove(t.id)
        expect(await b.collections.memberships('term')).toEqual([])
      })
    })
  })
}
