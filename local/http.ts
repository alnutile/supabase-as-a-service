// HTTP API for the local second brain. A plain fetch-style handler
// (Request -> Response) so Bun.serve can host it and tests can call it directly.
//
// Routes (JSON in, JSON out):
//   GET    /api/health
//   GET    /api/terminology               POST /api/terminology {term, definition, notes?}
//   GET    /api/terminology/:id           PATCH /api/terminology/:id {term?, definition?, notes?, visibility?}
//   DELETE /api/terminology/:id
//   GET    /api/collections               POST /api/collections {name}
//   GET    /api/collections/memberships?kind=term[&ids=a,b]
//   POST   /api/collections/:id/items {kind, itemIds}
//   DELETE /api/collections/:id/items {kind, itemIds}
import type { Backend } from '../src/lib/data/stores'
import type { CollectionItemKind, TermPatch } from '../src/lib/data/types'
import { ITEM_KINDS } from './store'

class BadRequest extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new BadRequest('expected a JSON object body')
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`"${key}" must be a non-empty string`)
  return v.trim()
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new BadRequest(`"${key}" must be a string`)
  return v
}

function kindOf(v: unknown): CollectionItemKind {
  if (typeof v === 'string' && (ITEM_KINDS as readonly string[]).includes(v)) return v as CollectionItemKind
  throw new BadRequest(`"kind" must be one of ${ITEM_KINDS.join(', ')}`)
}

function idList(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x)) {
    throw new BadRequest('"itemIds" must be an array of ids')
  }
  return v as string[]
}

export function createHandler(backend: Backend, info: { dbPath: string }) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean) // ['api', ...]
    if (parts[0] !== 'api') return json({ error: 'not found' }, 404)
    const [, resource, id, sub] = parts
    const method = req.method.toUpperCase()

    try {
      if (resource === 'health' && method === 'GET') {
        return json({ ok: true, backend: backend.name, db: info.dbPath })
      }

      if (resource === 'terminology') {
        if (!id) {
          if (method === 'GET') return json(await backend.terminology.list())
          if (method === 'POST') {
            const body = await readBody(req)
            const created = await backend.terminology.create({
              term: requiredText(body, 'term'),
              definition: requiredText(body, 'definition'),
              notes: optionalText(body, 'notes'),
            })
            return json(created, 201)
          }
        } else if (!sub) {
          if (method === 'GET') {
            const term = await backend.terminology.get(id)
            return term ? json(term) : json({ error: 'not found' }, 404)
          }
          if (method === 'PATCH') {
            const body = await readBody(req)
            const patch: TermPatch = {}
            for (const key of ['term', 'definition', 'notes'] as const) {
              const v = optionalText(body, key)
              if (v !== undefined) patch[key] = v
            }
            if (body.visibility !== undefined) {
              if (body.visibility !== 'private' && body.visibility !== 'workspace') {
                throw new BadRequest('"visibility" must be private or workspace')
              }
              patch.visibility = body.visibility
            }
            await backend.terminology.update(id, patch)
            return json({ ok: true })
          }
          if (method === 'DELETE') {
            await backend.terminology.remove(id)
            return json({ ok: true })
          }
        }
      }

      if (resource === 'collections') {
        if (!id) {
          if (method === 'GET') return json(await backend.collections.list())
          if (method === 'POST') {
            const body = await readBody(req)
            return json(await backend.collections.create({ name: requiredText(body, 'name') }), 201)
          }
        } else if (id === 'memberships' && !sub && method === 'GET') {
          const kind = kindOf(url.searchParams.get('kind'))
          const raw = url.searchParams.get('ids')
          const ids = raw === null ? undefined : raw.split(',').filter(Boolean)
          return json(await backend.collections.memberships(kind, ids))
        } else if (sub === 'items' && (method === 'POST' || method === 'DELETE')) {
          const body = await readBody(req)
          const kind = kindOf(body.kind)
          const itemIds = idList(body.itemIds)
          if (method === 'POST') await backend.collections.addItems(kind, id, itemIds)
          else await backend.collections.removeItems(kind, id, itemIds)
          return json({ ok: true })
        }
      }

      return json({ error: 'not found' }, 404)
    } catch (err) {
      if (err instanceof BadRequest) return json({ error: err.message }, 400)
      const message = err instanceof Error ? err.message : String(err)
      // A missing collection trips the foreign key: the caller's fault, not ours.
      if (/FOREIGN KEY/i.test(message)) return json({ error: 'unknown collection' }, 400)
      return json({ error: message }, 500)
    }
  }
}
