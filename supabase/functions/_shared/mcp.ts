// Shared MCP (Model Context Protocol) client — lets the workspace act as an MCP
// *client* against external servers (e.g. Zapier MCP fronting Gmail/Calendar).
// Used by all the agent loops (chat, scheduler, webhook). Each connected server
// is an `mcp_servers` row with a kind='mcp' tools handle, so any number of them
// light up everywhere at once.
//
// Transport: MCP Streamable HTTP (JSON-RPC 2.0 over POST). The server may answer
// with `application/json` OR an SSE (`text/event-stream`) frame, and may hand
// back an `Mcp-Session-Id` header during `initialize` that must be echoed on
// subsequent calls — we handle both. Each server's bearer token is read at call
// time from Vault via the service-role-only `read_mcp_secret(server_id)` RPC; it
// never lives in the tool row, the model context, or any log.
import { toORTool, type ORTool } from './openrouter.ts'
import { ensureAccessToken } from './mcp_oauth.ts'

// deno-lint-ignore no-explicit-any
type DB = any

const PROTOCOL = '2025-06-18'
const NS_SEP = '__'
const CACHE_TTL_MS = 10 * 60 * 1000 // re-discover the remote toolset at most this often
const MAX_RESULT = 50000

interface Server {
  url: string
  token: string
}

export interface CachedTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// A kind='mcp' tools handle row. `config.server_id` links it to its mcp_servers
// row, where the endpoint URL, Vault token pointer, and tool cache live.
interface McpToolRow {
  id: string
  name: string
  config: { url?: string; server_id?: string }
}

export type McpRouter = Map<string, { url: string; serverId: string; remote: string }>

function baseHeaders(server: Server, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${server.token}`,
    'MCP-Protocol-Version': PROTOCOL,
  }
  if (sessionId) h['Mcp-Session-Id'] = sessionId
  return h
}

// Parse either a plain JSON-RPC body or an SSE frame (one or more `data:` lines).
// deno-lint-ignore no-explicit-any
function parseResponse(text: string): any {
  const trimmed = text.trim()
  if (!trimmed) return {}
  if (trimmed[0] === '{' || trimmed[0] === '[') return JSON.parse(trimmed)
  // deno-lint-ignore no-explicit-any
  let last: any = null
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/)
    if (m && m[1] && m[1] !== '[DONE]') {
      try {
        last = JSON.parse(m[1])
      } catch {
        // skip non-JSON data lines (e.g. keep-alives)
      }
    }
  }
  if (last !== null) return last
  throw new Error('Unparseable MCP response')
}

async function rpc(
  server: Server,
  body: Record<string, unknown>,
  sessionId?: string,
  // deno-lint-ignore no-explicit-any
): Promise<{ json: any; sessionId: string | undefined }> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: baseHeaders(server, sessionId),
    body: JSON.stringify(body),
  })
  const newSession = res.headers.get('Mcp-Session-Id') ?? sessionId
  const text = await res.text()
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`)
  return { json: parseResponse(text), sessionId: newSession }
}

// initialize handshake → returns the session id (if the server issues one) so the
// caller can carry it on the follow-up tools/list or tools/call.
async function connect(server: Server): Promise<string | undefined> {
  const { json, sessionId } = await rpc(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'supabase-intranet', version: '1.0.0' },
    },
  })
  if (json?.error) throw new Error(`initialize failed: ${json.error.message ?? 'error'}`)
  // Best-effort "initialized" notification (no response expected). Some servers
  // require it before serving tools/list; ignore failures.
  try {
    await fetch(server.url, {
      method: 'POST',
      headers: baseHeaders(server, sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
  } catch {
    // ignore
  }
  return sessionId
}

// Discover the remote toolset. Throws on transport/protocol failure so callers
// can fall back to a stale cache.
export async function listRemoteTools(server: Server): Promise<CachedTool[]> {
  const sessionId = await connect(server)
  const { json } = await rpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId)
  if (json?.error) throw new Error(`tools/list failed: ${json.error.message ?? 'error'}`)
  // deno-lint-ignore no-explicit-any
  const list = (json?.result?.tools ?? []) as any[]
  return list.map((t) => ({
    name: String(t.name),
    description: String(t.description ?? ''),
    input_schema: (t.inputSchema ?? t.input_schema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
  }))
}

// deno-lint-ignore no-explicit-any
function flattenContent(result: any): string {
  if (!result) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result.content)) {
    return result.content
      // deno-lint-ignore no-explicit-any
      .map((c: any) => (c?.type === 'text' ? c.text : c?.text ?? JSON.stringify(c)))
      .join('\n')
  }
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
  return JSON.stringify(result)
}

// Resolve one server's live bearer. For bearer servers this is the static Vault
// token; for OAuth servers it's the stored access token, transparently refreshed
// when expired. Both paths live in ensureAccessToken (_shared/mcp_oauth.ts).
async function readToken(db: DB, serverId: string): Promise<string | null> {
  return await ensureAccessToken(db, serverId)
}

// A short, function-name-safe namespace prefix from the tool row name.
export function mcpPrefix(name: string): string {
  const p = (name || 'mcp').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return p || 'mcp'
}

// The namespaced function name for a remote tool: `‹label›__‹remote›`, capped at
// 64 chars (OpenAI/OpenRouter function-name limit). Pure + exported so both the
// agent-loop expansion and the MCP server that re-exposes these tools to an
// external Claude agree on the exact same name.
export function namespacedToolName(label: string, remote: string): string {
  return `${mcpPrefix(label)}${NS_SEP}${remote}`.slice(0, 64)
}

// Discover a server's toolset and cache it on its mcp_servers row. Used by the
// loops (lazy refresh) and the mcp-admin function (explicit "Connect & list").
export async function refreshServer(db: DB, serverId: string, url: string): Promise<CachedTool[]> {
  const token = await readToken(db, serverId)
  if (!token) throw new Error('No token is stored for this MCP server.')
  const tools = await listRemoteTools({ url, token })
  await db
    .from('mcp_servers')
    .update({ cached_tools: tools, cached_at: new Date().toISOString() })
    .eq('id', serverId)
  return tools
}

// Expand active `kind='mcp'` tool handles into OpenAI/OpenRouter function specs
// plus a router (namespaced name → server + remote tool). Each handle links to an
// mcp_servers row (URL + Vault token + cache); uses the cached toolset when fresh,
// otherwise re-discovers and writes the cache back. Discovery failures degrade
// gracefully to whatever cache exists (possibly none).
export async function expandMcpTools(
  db: DB,
  rows: McpToolRow[],
): Promise<{ tools: ORTool[]; router: McpRouter; capabilities: string[] }> {
  const tools: ORTool[] = []
  const router: McpRouter = new Map()
  const capabilities: string[] = []
  if (!db || !rows.length) return { tools, router, capabilities }

  for (const row of rows) {
    const serverId = row.config?.server_id
    if (!serverId) continue
    const { data: server } = await db
      .from('mcp_servers')
      .select('url, cached_tools, cached_at')
      .eq('id', serverId)
      .maybeSingle()
    const url = (server?.url as string | undefined) ?? row.config?.url
    if (!url) continue

    let cached = (server?.cached_tools as CachedTool[] | undefined) ?? []
    const at = server?.cached_at ? Date.parse(server.cached_at as string) : 0
    const stale = !cached.length || !Number.isFinite(at) || Date.now() - at > CACHE_TTL_MS
    if (stale) {
      try {
        cached = await refreshServer(db, serverId, url)
      } catch {
        // keep the existing (stale/empty) cache
      }
    }

    for (const t of cached) {
      const ns = namespacedToolName(row.name, t.name)
      tools.push(toORTool(ns, t.description, t.input_schema))
      router.set(ns, { url, serverId, remote: t.name })
      capabilities.push(`\`${ns}\` — ${t.description}`)
    }
  }
  return { tools, router, capabilities }
}

// Execute one MCP tool call: initialize → tools/call, returning text for the
// model. Never throws — returns an error string the model can read.
export async function runMcpTool(db: DB, router: McpRouter, name: string, input: unknown): Promise<string> {
  const entry = router.get(name)
  if (!entry) return `Unknown MCP tool: ${name}`
  const token = await readToken(db, entry.serverId)
  if (!token) return 'The MCP server is not configured (no token available).'
  const server: Server = { url: entry.url, token }
  try {
    const sessionId = await connect(server)
    const { json } = await rpc(
      server,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: entry.remote, arguments: input ?? {} } },
      sessionId,
    )
    if (json?.error) return `MCP tool error: ${json.error.message ?? 'error'}`
    if (json?.result?.isError) return `MCP tool reported an error: ${flattenContent(json.result).slice(0, MAX_RESULT)}`
    return flattenContent(json?.result).slice(0, MAX_RESULT) || '(no content)'
  } catch (err) {
    return `MCP tool call failed: ${err instanceof Error ? err.message : 'error'}`
  }
}
