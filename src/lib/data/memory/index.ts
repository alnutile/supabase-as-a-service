// In-memory backend: a plain-JS reference implementation of the stores. Unit
// tests run pages and logic against it, and it pins down the behaviour the
// local SQLite backend has to match (single user, no RLS).
import type { Backend, CollectionStore, TerminologyStore } from '../stores'
import type { Collection, CollectionItemKind, Membership, Term } from '../types'

export type MemorySeed = {
  terms?: Term[]
  collections?: Collection[]
  memberships?: Array<Membership & { kind: CollectionItemKind }>
}

export const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001'

let counter = 0
function newId(): string {
  counter += 1
  return `mem-${Date.now().toString(36)}-${counter}`
}

function now(): string {
  return new Date().toISOString()
}

export function createMemoryBackend(seed: MemorySeed = {}): Backend {
  const terms = new Map<string, Term>((seed.terms ?? []).map((t) => [t.id, { ...t }]))
  const collectionRows = (seed.collections ?? []).map((c) => ({ ...c }))
  // kind -> "collectionId|itemId"
  const members = new Map<CollectionItemKind, Set<string>>()
  for (const m of seed.memberships ?? []) {
    const set = members.get(m.kind) ?? new Set<string>()
    set.add(`${m.collectionId}|${m.itemId}`)
    members.set(m.kind, set)
  }
  const kindSet = (kind: CollectionItemKind) => {
    let set = members.get(kind)
    if (!set) {
      set = new Set()
      members.set(kind, set)
    }
    return set
  }

  const terminology: TerminologyStore = {
    async list() {
      return [...terms.values()].map((t) => ({ ...t })).sort((a, b) => a.term.localeCompare(b.term))
    },
    async get(id) {
      const t = terms.get(id)
      return t ? { ...t } : null
    },
    async create({ term, definition, notes }) {
      const row: Term = {
        id: newId(),
        owner_id: LOCAL_USER_ID,
        term,
        definition,
        notes: notes ?? '',
        source: {},
        visibility: 'private',
        created_at: now(),
        updated_at: now(),
      }
      terms.set(row.id, row)
      return { ...row }
    },
    async update(id, patch) {
      const t = terms.get(id)
      if (t) terms.set(id, { ...t, ...patch, updated_at: now() })
    },
    async remove(id) {
      terms.delete(id)
      // Join rows go with the item, like the ON DELETE CASCADE in Postgres.
      const set = kindSet('term')
      for (const key of [...set]) if (key.endsWith(`|${id}`)) set.delete(key)
    },
  }

  const collections: CollectionStore = {
    async list() {
      return collectionRows
        .map((c) => ({ ...c }))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
    },
    async memberships(kind, itemIds) {
      const filter = itemIds ? new Set(itemIds) : null
      return [...kindSet(kind)]
        .map((key) => {
          const [collectionId, itemId] = key.split('|')
          return { collectionId, itemId }
        })
        .filter((m) => !filter || filter.has(m.itemId))
    },
    async create({ name }) {
      const row: Collection = {
        id: newId(),
        owner_id: LOCAL_USER_ID,
        name,
        description: '',
        color: null,
        visibility: 'private',
        pinned: false,
        created_at: now(),
        updated_at: now(),
      }
      collectionRows.push(row)
      return { ...row }
    },
    async addItems(kind, collectionId, itemIds) {
      const set = kindSet(kind)
      for (const id of itemIds) set.add(`${collectionId}|${id}`)
    },
    async removeItems(kind, collectionId, itemIds) {
      const set = kindSet(kind)
      for (const id of itemIds) set.delete(`${collectionId}|${id}`)
    },
  }

  return { name: 'memory', terminology, collections }
}
