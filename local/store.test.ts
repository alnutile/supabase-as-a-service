// @vitest-environment node
// Runs the shared backend contract against the real SQLite store (Node's
// built-in node:sqlite stands in for bun:sqlite), both directly and through
// the HTTP layer + the UI's HTTP client, so all three agree.
//
// node:sqlite needs Node 22.5+. On older Node the suite is skipped; CI runs it
// in its own Node 22 job (.github/workflows/test.yml, "local").
import { describe, expect, it } from 'vitest'
import { runBackendContract } from '../src/lib/data/contract'
import { createHttpBackend } from '../src/lib/data/local'
import { createHandler } from './http'
import { migrate } from './schema'
import type { SqlDb } from './sql'
import { createSqliteBackend } from './store'

type SqliteModule = { DatabaseSync: new (path: string) => SqlDb }
const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
const sqlite = (getBuiltin?.('node:sqlite') ?? null) as SqliteModule | null

function openDb(): SqlDb {
  return new sqlite!.DatabaseSync(':memory:')
}

function freshDb(): SqlDb {
  const db = openDb()
  migrate(db)
  return db
}

describe.skipIf(!sqlite)('local backend (node:sqlite)', () => {
  runBackendContract('sqlite', () => createSqliteBackend(freshDb()))

  runBackendContract('sqlite over http', () => {
    const handle = createHandler(createSqliteBackend(freshDb()), { dbPath: ':memory:' })
    return createHttpBackend('http://brain.test', (input, init) => handle(new Request(input, init)))
  })

  describe('local schema', () => {
    it('migrates once and is idempotent', () => {
      const db = openDb()
      expect(migrate(db)).toEqual([1])
      expect(migrate(db)).toEqual([])
    })

    it('keeps the FTS5 index in step with terminology', async () => {
      const db = freshDb()
      const b = createSqliteBackend(db)
      const t = await b.terminology.create({ term: 'Embeddings', definition: 'vectors for semantic search' })
      await b.terminology.create({ term: 'BM25', definition: 'keyword ranking' })
      const search = (q: string) =>
        (db
          .prepare(
            `select t.term from terminology_fts f join terminology t on t.rowid = f.rowid
             where terminology_fts match ? order by rank`,
          )
          .all(q) as Array<{ term: string }>).map((r) => r.term)
      expect(search('semantic')).toEqual(['Embeddings'])
      await b.terminology.update(t.id, { definition: 'dense vectors' })
      expect(search('semantic')).toEqual([])
      await b.terminology.remove(t.id)
      expect(search('dense')).toEqual([])
    })
  })

  describe('local http api', () => {
    const handle = sqlite
      ? createHandler(createSqliteBackend(freshDb()), { dbPath: ':memory:' })
      : async () => new Response(null, { status: 500 })
    const req = (method: string, path: string, body?: unknown) =>
      handle(
        new Request(`http://brain.test${path}`, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )

    it('reports health', async () => {
      const res = await req('GET', '/api/health')
      expect(await res.json()).toMatchObject({ ok: true, backend: 'local' })
    })

    it('rejects bad input with 400', async () => {
      expect((await req('POST', '/api/terminology', { term: '', definition: 'x' })).status).toBe(400)
      expect((await req('POST', '/api/terminology', 'nope')).status).toBe(400)
      expect((await req('GET', '/api/collections/memberships?kind=agent')).status).toBe(400)
      expect((await req('POST', '/api/collections/missing/items', { kind: 'term', itemIds: ['a'] })).status).toBe(400)
      expect((await req('PATCH', '/api/terminology/x', { visibility: 'public' })).status).toBe(400)
    })

    it('404s unknown routes and missing terms', async () => {
      expect((await req('GET', '/api/nope')).status).toBe(404)
      expect((await req('GET', '/nope')).status).toBe(404)
      expect((await req('GET', '/api/terminology/missing')).status).toBe(404)
    })
  })
})
