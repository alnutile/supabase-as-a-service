// Supabase Edge Function: `mcp` (PUBLIC — verify_jwt=false).
// A Model Context Protocol server (JSON-RPC over HTTP) that an external Claude
// (Claude Code / Desktop) connects to. It exposes tools to BUILD things on this
// workspace — agents, tools, skills, webhooks, artifacts — so you can say
// "write an agent that does X on my system" and Claude pushes it here, where it
// shows up in the dashboard. Auth is a per-user token from `mcp_tokens`; every
// action runs as that token's owner.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''

type DB = ReturnType<typeof admin>

async function isAdmin(db: DB, owner: string): Promise<boolean> {
  const { data } = await db.from('profiles').select('is_admin').eq('id', owner).maybeSingle()
  return Boolean(data?.is_admin)
}

// --- Tool definitions exposed over MCP ---
const TOOLS = [
  {
    name: 'list_agents',
    description: 'List the agents defined on this workspace.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_agent',
    description:
      'Create a new agent: a deployable unit with a name, a system prompt (instructions), and optional tool ids it may use. Appears in the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        instructions: { type: 'string', description: 'The agent system prompt.' },
        description: { type: 'string' },
        tool_ids: { type: 'array', items: { type: 'string' }, description: 'Tool ids the agent may use.' },
      },
      required: ['name', 'instructions'],
    },
  },
  {
    name: 'list_tools',
    description: 'List the tools (capabilities) available on this workspace.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_http_tool',
    description:
      'Create a custom HTTP tool the assistant can call. Claude posts the inputs as JSON to the given URL. Admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'snake_case function name' },
        description: { type: 'string', description: 'When to use it.' },
        url: { type: 'string', description: 'Endpoint that receives the inputs.' },
        input_schema: { type: 'object', description: 'JSON Schema for the arguments.' },
        method: { type: 'string', enum: ['POST', 'GET'] },
      },
      required: ['name', 'description', 'url'],
    },
  },
  {
    name: 'create_skill',
    description:
      'Create a saved prompt/skill. Set always_on to apply it to every chat (admin only); otherwise it is an on-demand skill.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        instructions: { type: 'string' },
        description: { type: 'string' },
        always_on: { type: 'boolean' },
      },
      required: ['name', 'instructions'],
    },
  },
  {
    name: 'create_webhook',
    description: 'Create a webhook (a public URL that runs a prompt on inbound payloads). Returns the URL.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        prompt: { type: 'string', description: 'What to do with each payload.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_artifact',
    description: 'Create a shareable artifact (document). Returns its link.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string', enum: ['markdown', 'code', 'html', 'text'] },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'upload_file',
    description:
      'Upload a file (PDF, image, text, etc.) into the workspace Files area. PDFs are automatically indexed into the shared knowledge base. Provide the content base64-encoded; max 10 MB. For files larger than ~10 MB use create_file_upload + finalize_file_upload instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name including extension, e.g. report.pdf' },
        mime_type: { type: 'string', description: 'MIME type, e.g. application/pdf or image/png' },
        content_base64: { type: 'string', description: 'The file bytes, base64-encoded.' },
      },
      required: ['name', 'mime_type', 'content_base64'],
    },
  },
  {
    name: 'create_file_upload',
    description:
      'For large files (over ~10 MB): get a signed URL to PUT the file bytes directly to storage. Returns the upload URL and the storage path; afterwards call finalize_file_upload with the same path to register it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        mime_type: { type: 'string' },
      },
      required: ['name', 'mime_type'],
    },
  },
  {
    name: 'finalize_file_upload',
    description:
      'Register a file uploaded via a create_file_upload signed URL, so it appears in Files and PDFs get indexed. Use the path returned by create_file_upload.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The storage path returned by create_file_upload.' },
        name: { type: 'string' },
        mime_type: { type: 'string' },
        size_bytes: { type: 'number' },
      },
      required: ['path', 'name', 'mime_type'],
    },
  },
  {
    name: 'list_activity',
    description: 'Recent activity on the workspace (events, tool calls, creations).',
    inputSchema: { type: 'object', properties: {} },
  },
]

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB decoded

// Decode a base64 string to raw bytes (handles binary content).
function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64 // tolerate data: URLs
  const bin = atob(clean.trim())
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function text(t: string, isError = false) {
  return { content: [{ type: 'text', text: t }], isError }
}

// deno-lint-ignore no-explicit-any
async function callTool(db: DB, owner: string, name: string, args: any) {
  switch (name) {
    case 'list_agents': {
      const { data } = await db.from('agents').select('id, name, description, is_active').order('created_at', { ascending: false })
      return text((data ?? []).map((a) => `• ${a.name} (${a.id})${a.is_active ? '' : ' [inactive]'} — ${a.description || 'no description'}`).join('\n') || 'No agents yet.')
    }
    case 'create_agent': {
      const { data, error } = await db.from('agents').insert({
        owner_id: owner,
        name: args.name,
        description: args.description ?? '',
        instructions: args.instructions,
        tool_ids: Array.isArray(args.tool_ids) ? args.tool_ids : [],
      }).select('id').single()
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Created agent "${args.name}" (id ${data.id}). It's now in the dashboard under Agents.`)
    }
    case 'list_tools': {
      const { data } = await db.from('tools').select('id, name, kind, is_active')
      return text((data ?? []).map((t) => `• ${t.kind === 'web' ? 'web_browsing' : t.name} (${t.id}, ${t.kind})${t.is_active ? '' : ' [off]'}`).join('\n') || 'No tools.')
    }
    case 'create_http_tool': {
      if (!(await isAdmin(db, owner))) return text('Only admins can create tools.', true)
      const { data, error } = await db.from('tools').insert({
        name: args.name,
        description: args.description,
        kind: 'http',
        input_schema: args.input_schema ?? { type: 'object', properties: {} },
        config: { url: args.url, method: args.method ?? 'POST' },
        is_active: true,
        created_by: owner,
      }).select('id').single()
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Created tool "${args.name}" (id ${data.id}), enabled.`)
    }
    case 'create_skill': {
      const wantAlwaysOn = args.always_on === true
      if (wantAlwaysOn && !(await isAdmin(db, owner))) return text('Only admins can create always-on skills.', true)
      const { data, error } = await db.from('skills').insert({
        owner_id: owner,
        name: args.name,
        description: args.description ?? null,
        instructions: args.instructions,
        auto_apply: wantAlwaysOn,
      }).select('id').single()
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Created ${wantAlwaysOn ? 'always-on' : 'on-demand'} skill "${args.name}" (id ${data.id}).`)
    }
    case 'create_webhook': {
      const { data, error } = await db.from('webhooks').insert({
        owner_id: owner,
        name: args.name,
        prompt: args.prompt ?? '',
      }).select('token').single()
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Created webhook "${args.name}". POST payloads to:\n${SUPABASE_URL}/functions/v1/webhook/${data.token}`)
    }
    case 'create_artifact': {
      const type = ['markdown', 'code', 'html', 'text'].includes(args.type) ? args.type : 'markdown'
      const { data, error } = await db.from('artifacts').insert({
        owner_id: owner,
        title: args.title,
        type,
        content: args.content,
        visibility: 'private',
      }).select('id').single()
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Created artifact "${args.title}" at /artifacts/${data.id}.`)
    }
    case 'upload_file': {
      if (!args.name || !args.mime_type || !args.content_base64) {
        return text('upload_file needs name, mime_type, and content_base64.', true)
      }
      let bytes: Uint8Array
      try {
        bytes = decodeBase64(String(args.content_base64))
      } catch {
        return text('content_base64 is not valid base64.', true)
      }
      if (bytes.length === 0) return text('The file is empty.', true)
      if (bytes.length > MAX_UPLOAD_BYTES) {
        return text(
          `That file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; upload_file caps at 10 MB. Use create_file_upload + finalize_file_upload for larger files.`,
          true,
        )
      }
      const path = `${owner}/${crypto.randomUUID()}/${args.name}`
      const { error: upErr } = await db.storage
        .from('files')
        .upload(path, bytes, { contentType: String(args.mime_type), upsert: false })
      if (upErr) return text(`Upload failed: ${upErr.message}`, true)
      const { error: rowErr } = await db.from('files').insert({
        owner_id: owner,
        bucket: 'files',
        path,
        name: args.name,
        mime_type: args.mime_type,
        size_bytes: bytes.length,
        visibility: 'private',
      })
      if (rowErr) {
        await db.storage.from('files').remove([path])
        return text(`Saved the blob but couldn't register it: ${rowErr.message}`, true)
      }
      const isPdf = String(args.mime_type).includes('pdf') || /\.pdf$/i.test(String(args.name))
      return text(
        `Uploaded "${args.name}" (${(bytes.length / 1024).toFixed(0)} KB) to Files.` +
          (isPdf ? ' It will be indexed into the knowledge base shortly.' : ''),
      )
    }
    case 'create_file_upload': {
      if (!args.name || !args.mime_type) return text('create_file_upload needs name and mime_type.', true)
      const path = `${owner}/${crypto.randomUUID()}/${args.name}`
      const { data, error } = await db.storage.from('files').createSignedUploadUrl(path)
      if (error || !data) return text(`Could not create upload URL: ${error?.message ?? 'unknown error'}`, true)
      return text(
        `Upload URL ready. PUT the raw file bytes to this URL (it expires in ~2 hours), then call finalize_file_upload with path "${path}".\n\n` +
          `path: ${path}\nupload_url: ${data.signedUrl}\n\n` +
          `Example: curl -X PUT "${data.signedUrl}" -H "Content-Type: ${args.mime_type}" --data-binary @yourfile`,
      )
    }
    case 'finalize_file_upload': {
      if (!args.path || !args.name || !args.mime_type) {
        return text('finalize_file_upload needs path, name, and mime_type.', true)
      }
      if (!String(args.path).startsWith(`${owner}/`)) {
        return text('That path is not in your storage folder.', true)
      }
      const { error } = await db.from('files').insert({
        owner_id: owner,
        bucket: 'files',
        path: args.path,
        name: args.name,
        mime_type: args.mime_type,
        size_bytes: typeof args.size_bytes === 'number' ? args.size_bytes : 0,
        visibility: 'private',
      })
      if (error) return text(`Could not register the file: ${error.message}`, true)
      const isPdf = String(args.mime_type).includes('pdf') || /\.pdf$/i.test(String(args.name))
      return text(`Registered "${args.name}" in Files.` + (isPdf ? ' Indexing into the knowledge base shortly.' : ''))
    }
    case 'list_activity': {
      const { data } = await db.from('activity_log').select('type, summary, created_at').order('created_at', { ascending: false }).limit(20)
      return text((data ?? []).map((e) => `[${e.type}] ${e.summary}`).join('\n') || 'No activity.')
    }
    default:
      return text(`Unknown tool: ${name}`, true)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method === 'GET') {
    // No server-initiated stream in this stateless server.
    return new Response('MCP server. POST JSON-RPC here.', { status: 405, headers: CORS })
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS })

  // Resolve the token → owner.
  const url = new URL(req.url)
  const token =
    (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim() ||
    (url.searchParams.get('token') ?? '').trim()
  const db = admin()
  const { data: tok } = token
    ? await db.from('mcp_tokens').select('owner_id').eq('token', token).maybeSingle()
    : { data: null }
  if (!tok) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
  const owner = tok.owner_id as string
  db.from('mcp_tokens').update({ last_used_at: new Date().toISOString() }).eq('token', token).then(() => {})

  let body: { id?: unknown; method?: string; params?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const { id, method, params } = body
  const reply = (result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  const fail = (code: number, message: string) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  // Notifications (no id) get an empty 202.
  if (method?.startsWith('notifications/')) return new Response(null, { status: 202, headers: CORS })

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: (params?.protocolVersion as string) ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'Intranet', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = params?.name as string
      const args = (params?.arguments as Record<string, unknown>) ?? {}
      try {
        return reply(await callTool(db, owner, name, args))
      } catch (err) {
        return reply(text(`Tool failed: ${err instanceof Error ? err.message : 'error'}`, true))
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`)
  }
})
