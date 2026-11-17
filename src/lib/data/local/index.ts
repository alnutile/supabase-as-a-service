// Local backend: talks to the second-brain server (local/server.ts) over HTTP.
// In dev, Vite proxies /api to it (see vite.config.ts), so the UI and the
// server share an origin and the server needs no CORS.
import type { Backend, CollectionStore, TerminologyStore } from '../stores'
import type { Collection, Membership, Term } from '../types'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function createHttpBackend(baseUrl = '', fetchImpl: FetchLike = (i, init) => fetch(i, init)): Backend {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 404 && method === 'GET') return null as T
    const data = (await res.json().catch(() => null)) as T & { error?: string }
    if (!res.ok) throw new Error(data?.error ?? `${method} ${path} failed (${res.status})`)
    return data
  }

  const enc = encodeURIComponent

  const terminology: TerminologyStore = {
    list: async () => (await call<Term[]>('GET', '/api/terminology')) ?? [],
    get: (id) => call<Term | null>('GET', `/api/terminology/${enc(id)}`),
    create: (input) => call<Term>('POST', '/api/terminology', input),
    update: async (id, patch) => {
      await call('PATCH', `/api/terminology/${enc(id)}`, patch)
    },
    remove: async (id) => {
      await call('DELETE', `/api/terminology/${enc(id)}`)
    },
  }

  const collections: CollectionStore = {
    list: async () => (await call<Collection[]>('GET', '/api/collections')) ?? [],
    create: (input) => call<Collection>('POST', '/api/collections', input),
    memberships: async (kind, itemIds) => {
      if (itemIds && itemIds.length === 0) return []
      const ids = itemIds ? `&ids=${itemIds.map(enc).join(',')}` : ''
      return (await call<Membership[]>('GET', `/api/collections/memberships?kind=${enc(kind)}${ids}`)) ?? []
    },
    addItems: async (kind, collectionId, itemIds) => {
      if (!itemIds.length) return
      await call('POST', `/api/collections/${enc(collectionId)}/items`, { kind, itemIds })
    },
    removeItems: async (kind, collectionId, itemIds) => {
      if (!itemIds.length) return
      await call('DELETE', `/api/collections/${enc(collectionId)}/items`, { kind, itemIds })
    },
  }

  return { name: 'local', terminology, collections }
}

export const localBackend = createHttpBackend()
