// The SQLite implementation of the app's data stores (src/lib/data/stores.ts).
// The HTTP layer (http.ts) exposes it to the UI; the backend contract suite in
// src/lib/data/contract.ts runs against it directly.
import type { Backend, CollectionStore, TerminologyStore } from '../src/lib/data/stores'
import type { Collection, CollectionItemKind, Membership, Term, TermPatch } from '../src/lib/data/types'
import type { SqlDb, SqlValue } from './sql'

export const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001'

export const ITEM_KINDS: readonly CollectionItemKind[] = [
  'artifact',
  'file',
  'table',
  'todo',
  'link',
  'term',
  'whiteboard',
  'card_board',
]

const TERM_PATCH_KEYS = ['term', 'definition', 'notes', 'visibility'] as const

type TermRow = Omit<Term, 'source'> & { source: string }
type CollectionRow = Omit<Collection, 'pinned'> & { pinned: number }

function toTerm(r: TermRow): Term {
  let source: Term['source'] = {}
  try {
    source = JSON.parse(r.source)
  } catch {
    // keep {} for a malformed value
  }
  return { ...r, source }
}

function toCollection(r: CollectionRow): Collection {
  return { ...r, pinned: Boolean(r.pinned) }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

export function createSqliteBackend(db: SqlDb, now: () => string = () => new Date().toISOString()): Backend {
  const terminology: TerminologyStore = {
    async list() {
      const rows = db.prepare('select * from terminology order by term collate nocase, term').all() as TermRow[]
      return rows.map(toTerm)
    },
    async get(id) {
      const row = db.prepare('select * from terminology where id = ?').get(id) as TermRow | undefined
      return row ? toTerm(row) : null
    },
    async create({ term, definition, notes }) {
      const id = crypto.randomUUID()
      const ts = now()
      db.prepare(
        `insert into terminology (id, owner_id, term, definition, notes, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, LOCAL_USER_ID, term, definition, notes ?? '', ts, ts)
      return toTerm(db.prepare('select * from terminology where id = ?').get(id) as TermRow)
    },
    async update(id, patch: TermPatch) {
      const keys = TERM_PATCH_KEYS.filter((k) => patch[k] !== undefined)
      if (!keys.length) return
      const sets = keys.map((k) => `${k} = ?`).join(', ')
      const values = keys.map((k) => patch[k] as SqlValue)
      db.prepare(`update terminology set ${sets}, updated_at = ? where id = ?`).run(...values, now(), id)
    },
    async remove(id) {
      db.prepare('delete from terminology where id = ?').run(id)
    },
  }

  const collections: CollectionStore = {
    async list() {
      const rows = db
        .prepare('select * from collections order by pinned desc, name collate nocase, name')
        .all() as CollectionRow[]
      return rows.map(toCollection)
    },
    async create({ name }) {
      const id = crypto.randomUUID()
      const ts = now()
      db.prepare(
        `insert into collections (id, owner_id, name, created_at, updated_at) values (?, ?, ?, ?, ?)`,
      ).run(id, LOCAL_USER_ID, name, ts, ts)
      return toCollection(db.prepare('select * from collections where id = ?').get(id) as CollectionRow)
    },
    async memberships(kind, itemIds) {
      if (itemIds && itemIds.length === 0) return []
      const rows = (
        itemIds
          ? db
              .prepare(
                `select collection_id, item_id from collection_items
                 where kind = ? and item_id in (${placeholders(itemIds.length)})`,
              )
              .all(kind, ...itemIds)
          : db.prepare('select collection_id, item_id from collection_items where kind = ?').all(kind)
      ) as Array<{ collection_id: string; item_id: string }>
      return rows.map((r): Membership => ({ collectionId: r.collection_id, itemId: r.item_id }))
    },
    async addItems(kind, collectionId, itemIds) {
      const stmt = db.prepare(
        `insert or ignore into collection_items (kind, collection_id, item_id, created_at) values (?, ?, ?, ?)`,
      )
      const ts = now()
      for (const id of itemIds) stmt.run(kind, collectionId, id, ts)
    },
    async removeItems(kind, collectionId, itemIds) {
      if (!itemIds.length) return
      db.prepare(
        `delete from collection_items where kind = ? and collection_id = ? and item_id in (${placeholders(itemIds.length)})`,
      ).run(kind, collectionId, ...itemIds)
    },
  }

  return { name: 'local', terminology, collections }
}
