// Supabase Edge Function: `run-tool` (verify_jwt=false; auth checked in-body).
// The universal tool runner: invoke any ACTIVE tool from anywhere — the app UI,
// a script, a cron job, a Zap — without going through a model. This closes the
// "tools only run inside the agent loops" gap: the same `tools` rows the
// chat/webhook/scheduler loops use become directly callable, and a caller can
// CHAIN them deterministically with a `steps` array (each step may reference
// the previous step's output as {{prev}} inside string inputs).
//
// Auth (either works in the Authorization: Bearer header):
//   * a personal `mcp_tokens` token (Settings → Connect Claude / the API page)
//   * a Supabase session JWT (validated via auth.getUser — the function is
//     deployed verify_jwt=false for the token path, so the JWT is verified
//     here in code, never trusted from its payload alone)
// Every call runs AS the resolved user: builtins re-enforce private/workspace
// access in code exactly as they do in the agent loops.
//
// Dispatch mirrors the loops: `builtin` → runBuiltin, `http` → runHttpTool
// (vault {{vault:name}} refs resolve server-side, host-bound), `mcp` →
// namespaced remote tools (`label__remote`) via runMcpTool. `web` is an
// OpenRouter plugin, not an executable — it errors with an explanation.
// No guardrail runs here: nothing reaches an LLM (same reasoning as the
// webhook "call a function directly" mode); activation + per-user access rules
// are the gate, and every call is activity-logged (`tool.run`).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { runBuiltin } from '../_shared/builtins.ts'
import { runHttpTool } from '../_shared/http_tool.ts'
import { expandMcpTools, runMcpTool } from '../_shared/mcp.ts'
import { parseBearer, resolveApiUser } from '../_shared/apiauth.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
const MAX_STEPS = 10

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
function err(message: string, status: number) {
  return json({ error: message }, status)
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
}

// deno-lint-ignore no-explicit-any
type DB = any

type ToolRow = {
  id: string
  name: string
  kind: string
  description: string | null
  is_active: boolean
  config: Record<string, unknown> | null
}

// Caller resolution (an mcp_tokens token, else a verified Supabase JWT) is the
// shared _shared/apiauth.ts resolveApiUser — the same one the artifacts / todos
// REST APIs use, so one credential works across all three.

// Replace "{{prev}}" in any string value (deep) with the previous step result.
function substitutePrev(input: unknown, prev: string): unknown {
  if (typeof input === 'string') return input.replaceAll('{{prev}}', prev)
  if (Array.isArray(input)) return input.map((v) => substitutePrev(v, prev))
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, substitutePrev(v, prev)]))
  }
  return input
}

// Execute one named tool as `userId`. Returns the tool's text result, or an
// error string (tool results are model-shaped text everywhere in the system).
async function runOne(db: DB, ref: string, input: Record<string, unknown>, userId: string): Promise<string> {
  const name = ref.trim()
  if (!name) return 'No tool name given.'

  const { data: byName } = await db
    .from('tools')
    .select('id, name, kind, description, is_active, config')
    .eq('name', name)
    .maybeSingle()
  let row = (byName as ToolRow | null) ?? null
  if (!row && /^[0-9a-f-]{36}$/i.test(name)) {
    const { data: byId } = await db
      .from('tools')
      .select('id, name, kind, description, is_active, config')
      .eq('id', name)
      .maybeSingle()
    row = (byId as ToolRow | null) ?? null
  }

  // A namespaced MCP tool ("zapier__gmail_find_email") isn't a tools row —
  // expand the active MCP server handles and route through the shared client.
  if (!row && name.includes('__')) {
    const { data: mcpRows } = await db
      .from('tools')
      .select('id, name, kind, config')
      .eq('kind', 'mcp')
      .eq('is_active', true)
    const { router } = await expandMcpTools(db, mcpRows ?? [])
    if (router.has(name)) return await runMcpTool(db, router, name, input)
  }

  if (!row) return `Unknown tool "${name}". GET /run-tool/list shows the runnable tools.`
  if (!row.is_active) return `Tool "${name}" is not active — an admin can enable it on the Tools page.`

  switch (row.kind) {
    case 'builtin':
      return await runBuiltin(db, row.name, input, userId)
    case 'http':
      return await runHttpTool(db, row, input)
    case 'mcp': {
      // The row is a server HANDLE; its remote tools are called by namespaced name.
      const { capabilities } = await expandMcpTools(db, [
        { name: row.name, config: (row.config ?? {}) as { url?: string; server_id?: string } },
      ])
      return capabilities.length
        ? `"${row.name}" is an MCP server handle — call one of its tools by name:\n${capabilities.join('\n')}`
        : `"${row.name}" is an MCP server handle but its tool list is empty/unreachable.`
    }
    case 'web':
      return `"${row.name}" switches on the model's web-search plugin — it only works inside a chat/agent run, not as a direct call.`
    default:
      return `Tool kind "${row.kind}" cannot be run directly.`
  }
}

function docsResponse() {
  const text = `run-tool — invoke any active workspace tool directly (no model in the loop)

Auth: Authorization: Bearer <token>
  <token> is a personal connection token (Settings -> Connect Claude, or the
  API page) or a Supabase session JWT. Every call runs as you.

Endpoints
  GET  /run-tool/list          List runnable tools (name, kind, description, input schema).
  POST /run-tool               Run one tool, or a deterministic chain.

Run one tool
  { "tool": "list_todos", "input": { "status": "open" } }
  -> { "tool": "list_todos", "result": "..." }

Chain tools (max ${MAX_STEPS} steps, run in order; "{{prev}}" inside any string
input is replaced with the previous step's result text)
  { "steps": [
      { "tool": "http_request", "input": { "url": "https://example.com" } },
      { "tool": "add_note", "input": { "title": "Example page", "content": "{{prev}}" } }
  ] }
  -> { "steps": [ { "tool": "...", "result": "..." }, ... ], "result": "<last step's result>" }

Notes
  * builtin tools re-enforce private/workspace access as the caller.
  * http tools POST the input to their configured URL ({{vault:...}} refs resolve server-side).
  * MCP remote tools are called by their namespaced name, e.g. "zapier__gmail_find_email".
  * "web" tools are a model plugin and cannot be run directly.
  * Results are text (the same shape the model sees), capped at ~50k chars.
`
  return new Response(text, { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)
  const base = parts.indexOf('run-tool')
  const tail = base !== -1 ? parts[base + 1] : undefined

  const authHeader = req.headers.get('Authorization') ?? ''
  if (tail === 'docs' || (req.method === 'GET' && !tail && !authHeader)) return docsResponse()

  const token = parseBearer(authHeader)
  const db = admin()
  const userId = await resolveApiUser(db, token)
  if (!userId) return err('Unauthorized. See GET /functions/v1/run-tool/docs.', 401)

  if (req.method === 'GET' && tail === 'list') {
    const { data } = await db
      .from('tools')
      .select('name, kind, description, input_schema')
      .eq('is_active', true)
      .order('name', { ascending: true })
    const runnable = ((data ?? []) as Array<{ kind: string }>).filter((t) => t.kind !== 'web')
    return json({ tools: runnable })
  }
  if (req.method !== 'POST') return err('POST a JSON body, or GET /run-tool/list.', 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error()
  } catch {
    return err('Body must be a JSON object: {"tool": "...", "input": {...}} or {"steps": [...]}.', 400)
  }

  try {
    // Chain mode
    if (Array.isArray(body.steps)) {
      const steps = body.steps as Array<{ tool?: unknown; input?: unknown }>
      if (!steps.length) return err('steps is empty.', 400)
      if (steps.length > MAX_STEPS) return err(`Too many steps (max ${MAX_STEPS}).`, 400)
      const results: Array<{ tool: string; result: string }> = []
      let prev = ''
      for (const step of steps) {
        const toolName = String(step?.tool ?? '').trim()
        if (!toolName) return err('Each step needs a "tool" name.', 400)
        const rawInput = (step?.input && typeof step.input === 'object' ? step.input : {}) as Record<string, unknown>
        const input = substitutePrev(rawInput, prev) as Record<string, unknown>
        prev = await runOne(db, toolName, input, userId)
        results.push({ tool: toolName, result: prev })
      }
      await logRun(db, userId, results.map((r) => r.tool))
      return json({ steps: results, result: prev })
    }

    // Single-tool mode
    const toolName = String(body.tool ?? '').trim()
    if (!toolName) return err('Pass {"tool": "name", "input": {...}} or {"steps": [...]}.', 400)
    const input = (body.input && typeof body.input === 'object' ? body.input : {}) as Record<string, unknown>
    const result = await runOne(db, toolName, input, userId)
    await logRun(db, userId, [toolName])
    return json({ tool: toolName, result })
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Server error.', 500)
  }
})

async function logRun(db: DB, userId: string, tools: string[]) {
  try {
    await db.from('activity_log').insert({
      type: 'tool.run',
      summary: tools.length === 1 ? `Ran tool "${tools[0]}" directly` : `Ran a ${tools.length}-step tool chain`,
      detail: { tools, via: 'run-tool' },
      actor_id: userId,
    })
  } catch {
    // best-effort
  }
}
