// The workspace HTTP client.
//
// Everything here goes through surfaces that already exist and are already
// documented (`docs/artifacts-api.md`, `GET /run-tool/docs`): the extension
// adds NO server-side endpoint. That is the same rule the `supanet` CLI
// follows - if this needs something new, the fix belongs in `run-tool` or the
// REST functions, not in a bespoke endpoint for one client.
//
// Auth is a personal connection token (Settings -> Connect Claude, an
// `mcp_tokens` row) or a Supabase session JWT; the functions resolve either
// through `_shared/apiauth.ts` and run every call as that token's owner, so
// the extension can never reach data the signed-in user could not.
import { parseCollectionList, parseSaveLinkResult } from './parse.js'

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * @param {{baseUrl: string, token: string, fetchImpl?: typeof fetch}} opts
 */
export function createClient({ baseUrl, token, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis)
  const fnUrl = (path) => `${baseUrl.replace(/\/+$/, '')}/functions/v1${path}`

  async function request(path, init = {}) {
    let res
    try {
      res = await doFetch(fnUrl(path), {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      })
    } catch (e) {
      throw new ApiError(`Could not reach ${baseUrl}. Check the project URL and your connection. (${e.message})`)
    }
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!res.ok) {
      const message = body?.error
        ?? (res.status === 401 ? 'That token was rejected. Mint a new one in Settings -> Connect Claude.' : text.slice(0, 300))
      throw new ApiError(message || `Request failed (${res.status}).`, res.status)
    }
    return body
  }

  /** Run one workspace tool. Returns its text result. */
  async function runTool(tool, input = {}) {
    const body = await request('/run-tool', { method: 'POST', body: JSON.stringify({ tool, input }) })
    return String(body?.result ?? '')
  }

  return {
    /** Cheap round-trip that proves the URL + token are good. */
    async verify() {
      const body = await request('/run-tool/list', { method: 'GET' })
      const tools = Array.isArray(body?.tools) ? body.tools : []
      return { toolCount: tools.length, canSaveLinks: tools.some((t) => t?.name === 'save_link') }
    },

    async listCollections() {
      return parseCollectionList(await runTool('list_collections'))
    },

    /**
     * Save the page as a bookmark. The `save_link` builtin fetches the page's
     * own metadata server-side (title, description, og:image, favicon), so the
     * card in the app looks the same as one added by hand.
     */
    async saveLink({ url, title, notes, collection }) {
      const input = { url }
      if (title) input.title = title
      if (notes) input.notes = notes
      if (collection) input.collection = collection
      const parsed = parseSaveLinkResult(await runTool('save_link', input))
      if (!parsed.ok) throw new ApiError(parsed.message)
      return parsed
    },

    /** Save the page's text as a markdown artifact, optionally filed into collections. */
    async createArtifact({ title, content, collections = [], visibility = 'private' }) {
      const body = { title, content, type: 'markdown', visibility }
      if (collections.length) body.collections = collections
      return await request('/artifacts', { method: 'POST', body: JSON.stringify(body) })
    },

    runTool,
  }
}
