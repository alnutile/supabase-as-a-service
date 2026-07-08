// Supabase Edge Function: `mcp` (PUBLIC — verify_jwt=false).
// A Model Context Protocol server (JSON-RPC over HTTP) that an external Claude
// (Claude Code / Desktop) connects to. It exposes tools to BUILD things on this
// workspace — agents, tools, skills, webhooks, artifacts — so you can say
// "write an agent that does X on my system" and Claude pushes it here, where it
// shows up in the dashboard. Auth is a per-user token from `mcp_tokens`; every
// action runs as that token's owner.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { clampLimit, collectionRefs, isArtifactId, normalizeArtifactType } from '../_shared/artifacts.ts'
import { ingestText } from '../_shared/knowledge.ts'
import { addFileToCollection, createFile, deleteFile, getFile, listFiles } from '../_shared/files.ts'
import { expandMcpTools, type McpRouter, runMcpTool } from '../_shared/mcp.ts'
import {
  createLoop,
  findOrCreateLoopAgent,
  formatRun,
  getRun,
  latestRunForLoop,
  listLoopsText,
  resolveAgent,
  resolveFeedbackTool,
  resolveLoop,
  triggerLoopRun,
} from '../_shared/loops.ts'

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
      'Create a custom HTTP tool the assistant can call. Claude posts the inputs as JSON to the given URL. ' +
      'For authenticated APIs, set headers and reference a workspace Vault secret with {{vault:secret_name}} — ' +
      'it is resolved server-side at call time, so the credential never appears in the tool row or the conversation. Admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'snake_case function name' },
        description: { type: 'string', description: 'When to use it.' },
        url: { type: 'string', description: 'Endpoint that receives the inputs.' },
        input_schema: { type: 'object', description: 'JSON Schema for the arguments.' },
        method: { type: 'string', enum: ['POST', 'GET'] },
        headers: {
          type: 'object',
          description:
            'Headers sent with every call, e.g. {"Authorization": "Bearer {{vault:my_api_key}}"}. {{vault:name}} placeholders are replaced with workspace Vault secrets at call time.',
        },
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
    description:
      'Create a shareable artifact (document). Optionally file it into one or more collections (by name; created if missing) to centralize content from other systems — e.g. push a blog post or a YouTube transcript into a "Blog" or "YouTube" collection the team can chat with. Returns its id and link.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string', enum: ['markdown', 'code', 'html', 'text'] },
        collection: {
          type: 'string',
          description: 'Optional single collection name (or id) to file this artifact into; created if it does not exist.',
        },
        collections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional collection names (or ids) to file this artifact into; each created if missing.',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'list_artifacts',
    description:
      'List artifacts you can access, most recent first, with their ids — so after create_artifact (or a chat :::artifact) you can retrieve the id to file it into a collection. Optionally filter by collection (name/id), title_contains, or type.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Optional collection name or id to filter by.' },
        title_contains: { type: 'string', description: 'Optional case-insensitive substring of the title.' },
        type: { type: 'string', enum: ['markdown', 'code', 'html', 'text'], description: 'Optional artifact type filter.' },
        limit: { type: 'number', description: 'Max rows (default 20, max 100).' },
      },
    },
  },
  {
    name: 'get_artifact',
    description:
      'Read one artifact by its id OR its exact title: returns the id, title, type, url, collections it is in, and content. Title lookup finds artifacts created earlier in this session.',
    inputSchema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', description: 'The artifact id or its exact title.' },
      },
      required: ['artifact'],
    },
  },
  {
    name: 'list_collections',
    description: 'List the collections (named groups of artifacts) you can access.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_collection',
    description:
      'Create a collection: a named group of artifacts the user can later chat with as a focused context. Use this to centralize content from another system (blog posts, videos, notes) under one name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        shared: { type: 'boolean', description: 'Share with the whole workspace (default private to you).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_to_collection',
    description:
      'Add an existing artifact to a collection. The artifact is identified by artifact_id OR artifact_title (exact, resolved server-side — so you can file without ever seeing the id); the collection by name or id, created if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name or id.' },
        artifact_id: { type: 'string', description: 'The artifact id to add (or use artifact_title).' },
        artifact_title: { type: 'string', description: 'The exact artifact title to add (alternative to artifact_id).' },
      },
      required: ['collection'],
    },
  },
  {
    name: 'create_todo',
    description:
      'Create a to-do (a task to remember). Optionally set a due date (YYYY-MM-DD) and file it into a collection (by name; created if missing). Use this to capture tasks for the user.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string', description: 'Optional longer notes.' },
        due_date: { type: 'string', description: 'Optional due date, YYYY-MM-DD.' },
        collection: {
          type: 'string',
          description: 'Optional collection name (or id) to file this to-do into; created if missing.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_todos',
    description: 'List to-dos (optionally filter by collection name/id, or status open|done). Shows due dates and ids.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Optional collection name or id to filter by.' },
        status: { type: 'string', enum: ['open', 'done'], description: 'Filter by status (optional).' },
      },
    },
  },
  {
    name: 'complete_todo',
    description: 'Mark a to-do as done.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The to-do id.' } },
      required: ['id'],
    },
  },
  {
    name: 'update_todo',
    description: 'Update a to-do: title, notes, due_date (YYYY-MM-DD or null to clear), or done (true/false).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD, or null to clear.' },
        done: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_todo_to_collection',
    description: 'Add an existing to-do to a collection (both by name or id). The collection is created if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name or id.' },
        todo_id: { type: 'string', description: 'The to-do id to add.' },
      },
      required: ['collection', 'todo_id'],
    },
  },
  {
    name: 'add_table_to_collection',
    description: 'Add an existing data table to a collection (both by name or id). The collection is created if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name or id.' },
        table: { type: 'string', description: 'The table name or id to add.' },
      },
      required: ['collection', 'table'],
    },
  },
  {
    name: 'create_file',
    description:
      'Create a file in the workspace Files area from base64 bytes OR plain text, and get back a stable, shareable URL + file id. Use this to PERSIST generated output — most importantly a base64 image (e.g. gpt-image-1 b64_json): pass content_base64 + filename + mime_type and hand the returned url back to the user as a clickable link. Provide exactly one of content_base64 / content_text. Max 10 MB; allowed types: image/png, image/jpeg, image/webp, image/gif, application/pdf, text/plain, text/markdown, text/csv, application/json. PDFs are auto-indexed into the knowledge base. Appears in the Files UI.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Name including extension, e.g. fishing-diorama.png. Drives the content-type if mime_type is omitted.' },
        content_base64: { type: 'string', description: 'Base64-encoded bytes (images, PDFs, etc.). One of content_base64 / content_text.' },
        content_text: { type: 'string', description: 'Plain text/markdown content. One of content_base64 / content_text.' },
        mime_type: { type: 'string', description: 'Defaults inferred from the extension (e.g. image/png).' },
        visibility: { type: 'string', enum: ['private', 'workspace'], description: 'private (default) or workspace (link-shared).' },
        collection: { type: 'string', description: 'Optional collection name (or id) to file it into; created if missing.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        source: { type: 'object', description: 'Optional provenance, e.g. {"generator":"gpt-image-1","prompt":"…"}.' },
      },
      required: ['filename'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in the Files area (metadata only). Filter by collection (name/id), tag, or mime_prefix (e.g. "image/"). limit default 50, max 200.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Optional collection name or id to filter by.' },
        tag: { type: 'string', description: 'Optional tag to filter by.' },
        mime_prefix: { type: 'string', description: 'Optional MIME prefix, e.g. "image/" or "application/pdf".' },
        limit: { type: 'number', description: 'Max rows (default 50, max 200).' },
      },
    },
  },
  {
    name: 'get_file',
    description: 'Get one file\'s metadata and a fresh 7-day signed URL by id or filename. Set include_text=true to also return the text body of a small text/markdown file.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The file id.' },
        filename: { type: 'string', description: 'Or the exact filename.' },
        include_text: { type: 'boolean', description: 'Return content_text for small text files (default false).' },
      },
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file by id (or filename): removes both the storage object and the Files row.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The file id.' },
        filename: { type: 'string', description: 'Or the exact filename.' },
      },
    },
  },
  {
    name: 'add_file_to_collection',
    description: 'Add an existing file to a collection (both by name or id). The collection is created if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name or id.' },
        file_id: { type: 'string', description: 'The file id to add (or its filename).' },
      },
      required: ['collection', 'file_id'],
    },
  },
  {
    name: 'upload_file',
    description:
      'Upload a file (PDF, image, text, etc.) into the workspace Files area. PDFs are automatically indexed into the shared knowledge base. Provide the content base64-encoded; max 10 MB. For files larger than ~10 MB use create_file_upload + finalize_file_upload instead. (create_file is the richer variant — it also returns a shareable URL and accepts text/tags/collection.)',
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
    name: 'add_note',
    description:
      'Add a text note — meeting notes, a transcript, a doc, any plain text — to the workspace shared knowledge base. The text is chunked, embedded, and made searchable by the whole team via the assistant\'s search_documents tool. Use this to push Granola/meeting notes or other text your client can read straight into the team knowledge base. No file is created; for binary files (PDFs, images) use upload_file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short title, e.g. the meeting name + date ("Standup 2026-06-20").' },
        content: { type: 'string', description: 'The full note / transcript text to index.' },
        scope: {
          type: 'string',
          enum: ['workspace', 'private'],
          description: 'workspace (default) = searchable by the whole team; private = only you.',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'list_activity',
    description: 'Recent activity on the workspace (events, tool calls, creations).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tables',
    description: 'List the user-created data tables you can access (name, visibility, and columns).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_table',
    description:
      'Create a new user data table (real Postgres table) with typed columns. It appears in the Tables dashboard and the assistant can read/write it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        visibility: {
          type: 'string',
          enum: ['private', 'workspace'],
          description: 'workspace = shared with the team (default private).',
        },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              type: {
                type: 'string',
                enum: ['text', 'longtext', 'number', 'integer', 'boolean', 'date', 'datetime', 'json'],
              },
            },
            required: ['label', 'type'],
          },
        },
      },
      required: ['name', 'columns'],
    },
  },
  {
    name: 'query_table',
    description:
      'Read rows from a user data table. Returns each row with its id (use it with update_table_row / delete_table_row). Optional column=value filters and a limit (default 50, max 200).',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table name (or id).' },
        filters: { type: 'object', description: 'Optional column=value equality filters.' },
        limit: { type: 'number', description: 'Max rows to return (default 50, max 200).' },
      },
      required: ['table'],
    },
  },
  {
    name: 'add_table_row',
    description: 'Add a row to a user data table. Identify the table by name; pass column values as an object.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table name (or id).' },
        values: { type: 'object', description: 'Column key/value pairs.' },
      },
      required: ['table', 'values'],
    },
  },
  {
    name: 'update_table_row',
    description:
      'Update existing row(s) in a user data table. Identify the table by name, pass a "match" object of column=value filters selecting which row(s) to change (e.g. {"id": 3}), and a "values" object with the columns to set.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table name (or id).' },
        match: { type: 'object', description: 'Column=value equality filters identifying which row(s) to update.' },
        values: { type: 'object', description: 'Column key/value pairs to set.' },
      },
      required: ['table', 'match', 'values'],
    },
  },
  {
    name: 'delete_table_row',
    description:
      'Delete a single row from a user data table. Identify the table by name and the row by its "row_id" (from query_table). Deletes exactly one row; errors if the row is not found.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table name (or id).' },
        row_id: { type: 'string', description: 'The id of the row to delete (from query_table).' },
      },
      required: ['table', 'row_id'],
    },
  },
  {
    name: 'list_loops',
    description: 'List the goal-directed loops you can run (name, goal, budget, iteration cap).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_loop',
    description:
      'Create a loop: a goal-directed run that iterates toward a goal, scoring each candidate 0–100 and keeping the best, stopping when it hits its budget, iteration cap, target score, or converges. Give it a goal (the prompt) and a rubric (how to grade candidates). Runs against an agent — omit "agent" to use a default one. Appears in the Loops dashboard; run it with run_loop.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The objective the loop optimizes toward (the prompt).' },
        rubric: {
          type: 'string',
          description: 'How to grade each candidate 0–100. Used by the built-in judge when no feedback tool is set.',
        },
        name: { type: 'string', description: 'Optional label; defaults to the goal.' },
        max_iterations: { type: 'integer', description: 'Max rounds, 1–50 (default 10).' },
        budget_usd: { type: 'number', description: 'Hard model-cost cap in USD for the whole run (default 1).' },
        target_score: { type: 'number', description: 'Stop early once the best score reaches this (0–100, optional).' },
        agent: { type: 'string', description: 'Optional agent name/id to run; a default loop agent is used if omitted.' },
        feedback_tool: {
          type: 'string',
          description: 'Optional http tool name/id that scores candidates ({score, detail}); the judge + rubric is used if omitted.',
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'run_loop',
    description:
      'Start a run of an existing loop (by name or id). It runs in the background until it hits its budget, iteration cap, target score, or converges. Returns a run id — poll it with get_loop_run.',
    inputSchema: {
      type: 'object',
      properties: { loop: { type: 'string', description: 'The loop name or id to run.' } },
      required: ['loop'],
    },
  },
  {
    name: 'get_loop_run',
    description:
      "Check in on a loop run: its status, iterations, cost so far, best score, and (once done) the best output. Pass the run_id from run_loop, or a loop name/id to get its latest run.",
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'The run id returned by run_loop.' },
        loop: { type: 'string', description: 'Or a loop name/id to check its latest run.' },
      },
    },
  },
]

// Tables the MCP owner may use (their own + workspace-shared).
async function ownerTables(db: DB, owner: string) {
  const { data } = await db
    .from('user_tables')
    .select('id, name, physical_name, owner_id, columns, visibility')
    .or(`owner_id.eq.${owner},visibility.eq.workspace`)
  return (data ?? []) as Array<{
    id: string
    name: string
    physical_name: string
    owner_id: string
    columns: Array<{ key: string; label: string; type: string }>
    visibility: string
  }>
}

// Resolve a collection by id or name for this owner (their own + workspace-shared);
// optionally create it (owned by `owner`, private) when missing.
async function resolveCollection(
  db: DB,
  owner: string,
  ref: string,
  createIfMissing: boolean,
): Promise<{ id: string; name: string } | null> {
  const r = ref.trim()
  if (!r) return null
  const { data } = await db
    .from('collections')
    .select('id, name, owner_id, visibility')
    .or(`owner_id.eq.${owner},visibility.eq.workspace`)
  const found = (data ?? []).find(
    (c: { id: string; name: string }) => c.id === r || c.name.trim().toLowerCase() === r.toLowerCase(),
  )
  if (found) return { id: found.id, name: found.name }
  if (!createIfMissing) return null
  const { data: created } = await db
    .from('collections')
    .insert({ owner_id: owner, name: r, visibility: 'private' })
    .select('id, name')
    .single()
  return created ? { id: created.id, name: created.name } : null
}

// Resolve one artifact by id or exact title (case-insensitive) for this owner
// (their own or any shared artifact). Newest match wins on a title collision.
async function resolveArtifact(
  db: DB,
  owner: string,
  ref: string,
): Promise<{ id: string; title: string; type: string; content: string; data: unknown } | null> {
  let q = db.from('artifacts').select('id, title, type, content, data, owner_id, visibility, updated_at')
  q = q.or(`owner_id.eq.${owner},visibility.neq.private`)
  q = isArtifactId(ref) ? q.eq('id', ref) : q.ilike('title', ref)
  const { data } = await q.order('updated_at', { ascending: false }).limit(1)
  return (data?.[0] as { id: string; title: string; type: string; content: string; data: unknown } | undefined) ?? null
}

// Map artifact id → collection names it belongs to (for the given ids only).
async function artifactCollectionsMap(db: DB, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (!ids.length) return map
  const { data } = await db
    .from('collection_artifacts')
    .select('artifact_id, collections(name)')
    .in('artifact_id', ids)
  for (const row of (data ?? []) as Array<{ artifact_id: string; collections: { name: string } | null }>) {
    const name = row.collections?.name
    if (!name) continue
    const list = map.get(row.artifact_id) ?? []
    list.push(name)
    map.set(row.artifact_id, list)
  }
  return map
}

// File an artifact into each named collection (name or id; created if missing).
// Returns the names actually filed into.
async function fileArtifactIntoCollections(
  db: DB,
  owner: string,
  artifactId: string,
  refs: string[],
): Promise<string[]> {
  const filed: string[] = []
  for (const ref of refs) {
    const col = await resolveCollection(db, owner, ref, true)
    if (!col) continue
    const { error } = await db.from('collection_artifacts').upsert(
      { collection_id: col.id, artifact_id: artifactId, added_by: owner },
      { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
    )
    if (!error && !filed.includes(col.name)) filed.push(col.name)
  }
  return filed
}

function slugifyKey(label: string): string {
  const s = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!s) return 'col'
  return /^[a-z]/.test(s) ? s : `c_${s}`
}

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
        config: {
          url: args.url,
          method: args.method ?? 'POST',
          ...(args.headers && typeof args.headers === 'object' ? { headers: args.headers } : {}),
        },
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
      const type = normalizeArtifactType(args.type)
      const { data, error } = await db.from('artifacts').insert({
        owner_id: owner,
        title: args.title,
        type,
        content: args.content,
        visibility: 'private',
      }).select('id').single()
      if (error) return text(`Error: ${error.message}`, true)
      const refs = collectionRefs(args)
      const filed = refs.length ? await fileArtifactIntoCollections(db, owner, data.id, refs) : []
      const note = filed.length ? ` Filed into collection${filed.length > 1 ? 's' : ''}: ${filed.join(', ')}.` : ''
      return text(`Created artifact "${args.title}" (id ${data.id}) at /artifacts/${data.id}.${note}`)
    }
    case 'list_artifacts': {
      const limit = clampLimit(args.limit, 20, 100)
      let memberIds: string[] | null = null
      const colRef = typeof args.collection === 'string' ? args.collection.trim() : ''
      if (colRef) {
        const col = await resolveCollection(db, owner, colRef, false)
        if (!col) return text(`Collection "${colRef}" not found.`)
        const { data: members } = await db.from('collection_artifacts').select('artifact_id').eq('collection_id', col.id)
        memberIds = (members ?? []).map((m: { artifact_id: string }) => m.artifact_id)
        if (!memberIds.length) return text(`No artifacts in collection "${col.name}".`)
      }
      let q = db
        .from('artifacts')
        .select('id, title, type, created_at')
        .or(`owner_id.eq.${owner},visibility.neq.private`)
        .order('created_at', { ascending: false })
        .limit(limit)
      const titleContains = typeof args.title_contains === 'string' ? args.title_contains.trim() : ''
      if (titleContains) q = q.ilike('title', `%${titleContains}%`)
      const typeFilter = String(args.type ?? args.mime_type ?? '').trim().toLowerCase()
      if (['markdown', 'code', 'html', 'text'].includes(typeFilter)) q = q.eq('type', typeFilter)
      if (memberIds) q = q.in('id', memberIds)
      const { data, error } = await q
      if (error) return text(`Error: ${error.message}`, true)
      const rows = (data ?? []) as Array<{ id: string; title: string; type: string; created_at: string }>
      if (!rows.length) return text('No artifacts match. Use create_artifact to make one.')
      const cols = await artifactCollectionsMap(db, rows.map((r) => r.id))
      return text(
        rows
          .map((r) => {
            const inCols = cols.get(r.id) ?? []
            const when = new Date(r.created_at).toISOString().slice(0, 10)
            return `• ${r.title} (${r.type}) — id: ${r.id} — created ${when}${
              inCols.length ? ` — collections: ${inCols.join(', ')}` : ''
            } — /artifacts/${r.id}`
          })
          .join('\n'),
      )
    }
    case 'get_artifact': {
      const ref = String(args.artifact ?? '').trim()
      if (!ref) return text('get_artifact needs an artifact id or exact title.', true)
      const art = await resolveArtifact(db, owner, ref)
      if (!art) return text(`No artifact matches "${ref}".`, true)
      const inCols = (await artifactCollectionsMap(db, [art.id])).get(art.id) ?? []
      const cap = 16_000
      const clipped = art.content.length > cap
      const content = clipped ? art.content.slice(0, cap) : art.content
      return text([
        `id: ${art.id}`,
        `title: ${art.title}`,
        `type: ${art.type}`,
        `url: /artifacts/${art.id}`,
        `collections: ${inCols.length ? inCols.join(', ') : '(none)'}`,
        `content${clipped ? ` (first ${cap} chars — it is longer)` : ''}:`,
        content,
      ].join('\n'))
    }
    case 'list_collections': {
      const { data } = await db
        .from('collections')
        .select('id, name, description, visibility, owner_id')
        .or(`owner_id.eq.${owner},visibility.eq.workspace`)
        .order('name', { ascending: true })
      if (!data || !data.length) return text('No collections yet. Use create_collection to make one.')
      return text(
        data
          .map((c) => `• ${c.name} (${c.id}) [${c.visibility}]${c.description ? ` — ${c.description}` : ''}`)
          .join('\n'),
      )
    }
    case 'create_collection': {
      const name = String(args.name ?? '').trim()
      if (!name) return text('create_collection needs a name.', true)
      const { data, error } = await db.from('collections').insert({
        owner_id: owner,
        name,
        description: String(args.description ?? ''),
        visibility: args.shared === true ? 'workspace' : 'private',
      }).select('id, name, visibility').single()
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Created collection "${data.name}" (id ${data.id}, ${data.visibility}). Add artifacts with add_to_collection.`)
    }
    case 'add_to_collection': {
      const ref = String(args.collection ?? '').trim()
      if (!ref) return text('add_to_collection needs a collection.', true)
      let artifactId = String(args.artifact_id ?? '').trim()
      const titleRef = String(args.artifact_title ?? '').trim()
      if (!artifactId && titleRef) {
        const art = await resolveArtifact(db, owner, titleRef)
        if (!art) return text(`No artifact matches the title "${titleRef}".`, true)
        artifactId = art.id
      }
      if (!artifactId) return text('add_to_collection needs artifact_id or artifact_title.', true)
      const col = await resolveCollection(db, owner, ref, true)
      if (!col) return text(`Could not resolve collection "${ref}".`, true)
      const { error } = await db.from('collection_artifacts').upsert(
        { collection_id: col.id, artifact_id: artifactId, added_by: owner },
        { onConflict: 'collection_id,artifact_id', ignoreDuplicates: true },
      )
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Added artifact ${artifactId} to collection "${col.name}".`)
    }
    case 'create_todo': {
      const title = String(args.title ?? '').trim()
      if (!title) return text('create_todo needs a title.', true)
      const due = typeof args.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.due_date.trim())
        ? args.due_date.trim()
        : null
      const { data, error } = await db.from('todos').insert({
        owner_id: owner,
        title,
        notes: String(args.notes ?? ''),
        due_date: due,
        visibility: 'private',
      }).select('id').single()
      if (error) return text(`Error: ${error.message}`, true)
      let note = ''
      if (typeof args.collection === 'string' && args.collection.trim()) {
        const col = await resolveCollection(db, owner, args.collection, true)
        if (col) {
          await db.from('collection_todos').upsert(
            { collection_id: col.id, todo_id: data.id, added_by: owner },
            { onConflict: 'collection_id,todo_id', ignoreDuplicates: true },
          )
          note = ` Filed into collection "${col.name}".`
        }
      }
      return text(`Created to-do "${title}" (id ${data.id})${due ? `, due ${due}` : ''}.${note}`)
    }
    case 'list_todos': {
      let query = db
        .from('todos')
        .select('id, title, due_date, done')
        .or(`owner_id.eq.${owner},visibility.eq.workspace`)
        .order('done', { ascending: true })
        .order('due_date', { ascending: true, nullsFirst: false })
      if (args.status === 'done') query = query.eq('done', true)
      else if (args.status === 'open') query = query.eq('done', false)
      if (typeof args.collection === 'string' && args.collection.trim()) {
        const col = await resolveCollection(db, owner, args.collection, false)
        if (!col) return text(`Collection "${args.collection}" not found.`)
        const { data: members } = await db.from('collection_todos').select('todo_id').eq('collection_id', col.id)
        const ids = (members ?? []).map((m) => m.todo_id)
        if (!ids.length) return text(`No to-dos in collection "${col.name}".`)
        query = query.in('id', ids)
      }
      const { data } = await query
      if (!data || !data.length) return text('No to-dos.')
      return text(
        data
          .map((t) => `• [${t.done ? 'x' : ' '}] ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''} — ${t.id}`)
          .join('\n'),
      )
    }
    case 'complete_todo': {
      const id = String(args.id ?? '').trim()
      if (!id) return text('complete_todo needs an id.', true)
      const { data, error } = await db
        .from('todos')
        .update({ done: true, completed_at: new Date().toISOString() })
        .eq('id', id)
        .or(`owner_id.eq.${owner},visibility.eq.workspace`)
        .select('id')
        .maybeSingle()
      if (error) return text(`Error: ${error.message}`, true)
      if (!data) return text(`To-do ${id} not found (or not yours).`, true)
      return text(`Marked to-do ${id} as done.`)
    }
    case 'update_todo': {
      const id = String(args.id ?? '').trim()
      if (!id) return text('update_todo needs an id.', true)
      const patch: Record<string, unknown> = {}
      if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim()
      if (typeof args.notes === 'string') patch.notes = args.notes
      if (args.due_date === null) patch.due_date = null
      else if (typeof args.due_date === 'string') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(args.due_date.trim())) return text('due_date must be YYYY-MM-DD or null.', true)
        patch.due_date = args.due_date.trim()
      }
      if (typeof args.done === 'boolean') {
        patch.done = args.done
        patch.completed_at = args.done ? new Date().toISOString() : null
      }
      if (Object.keys(patch).length === 0) return text('No fields to update.')
      const { data, error } = await db
        .from('todos')
        .update(patch)
        .eq('id', id)
        .or(`owner_id.eq.${owner},visibility.eq.workspace`)
        .select('id')
        .maybeSingle()
      if (error) return text(`Error: ${error.message}`, true)
      if (!data) return text(`To-do ${id} not found (or not yours).`, true)
      return text(`Updated to-do ${id}.`)
    }
    case 'add_todo_to_collection': {
      const ref = String(args.collection ?? '').trim()
      const todoId = String(args.todo_id ?? '').trim()
      if (!ref || !todoId) return text('add_todo_to_collection needs collection and todo_id.', true)
      const col = await resolveCollection(db, owner, ref, true)
      if (!col) return text(`Could not resolve collection "${ref}".`, true)
      const { error } = await db.from('collection_todos').upsert(
        { collection_id: col.id, todo_id: todoId, added_by: owner },
        { onConflict: 'collection_id,todo_id', ignoreDuplicates: true },
      )
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Added to-do ${todoId} to collection "${col.name}".`)
    }
    case 'add_table_to_collection': {
      const ref = String(args.collection ?? '').trim()
      const tableRef = String(args.table ?? '').trim()
      if (!ref || !tableRef) return text('add_table_to_collection needs collection and table.', true)
      const r = tableRef.toLowerCase()
      const t = (await ownerTables(db, owner)).find((x) => x.id === tableRef || x.name.trim().toLowerCase() === r)
      if (!t) return text(`No table named "${tableRef}" that you can access.`, true)
      const col = await resolveCollection(db, owner, ref, true)
      if (!col) return text(`Could not resolve collection "${ref}".`, true)
      const { error } = await db.from('collection_tables').upsert(
        { collection_id: col.id, table_id: t.id, added_by: owner },
        { onConflict: 'collection_id,table_id', ignoreDuplicates: true },
      )
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Added table "${t.name}" to collection "${col.name}".`)
    }
    case 'create_file':
      return text(await createFile(db, owner, args))
    case 'list_files':
      return text(await listFiles(db, owner, args))
    case 'get_file':
      return text(await getFile(db, owner, args))
    case 'delete_file':
      return text(await deleteFile(db, owner, args))
    case 'add_file_to_collection':
      return text(await addFileToCollection(db, owner, args))
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
    case 'add_note': {
      const title = String(args.title ?? '').trim()
      const content = String(args.content ?? '')
      if (!title) return text('add_note needs a title.', true)
      if (content.trim().length < 20) {
        return text('That note is too short to index — provide at least ~20 characters of text.', true)
      }
      const scope = args.scope === 'private' ? 'private' : 'workspace'
      try {
        const { chunkCount } = await ingestText(db, { ownerId: owner, name: title, text: content, scope })
        return text(
          `Added "${title}" to the knowledge base (${chunkCount} chunk${chunkCount === 1 ? '' : 's'}, ${
            scope === 'workspace' ? 'searchable by the whole team' : 'visible only to you'
          }). The assistant can now find it via search_documents.`,
        )
      } catch (err) {
        return text(`Could not add the note: ${err instanceof Error ? err.message : 'error'}`, true)
      }
    }
    case 'list_activity': {
      const { data } = await db.from('activity_log').select('type, summary, created_at').order('created_at', { ascending: false }).limit(20)
      return text((data ?? []).map((e) => `[${e.type}] ${e.summary}`).join('\n') || 'No activity.')
    }
    case 'list_tables': {
      const tables = await ownerTables(db, owner)
      if (!tables.length) return text('No data tables yet. Use create_table to make one.')
      return text(
        tables
          .map((t) => {
            const cols = (t.columns ?? []).map((c) => `${c.key} (${c.type})`).join(', ') || 'no columns'
            return `• ${t.name} [${t.visibility}] — ${cols}`
          })
          .join('\n'),
      )
    }
    case 'create_table': {
      const name = String(args.name ?? '').trim()
      if (!name) return text('create_table needs a name.', true)
      const visibility = args.visibility === 'workspace' ? 'workspace' : 'private'
      const cols = (Array.isArray(args.columns) ? args.columns : []).map((c: { label?: string; name?: string; type?: string }) => {
        const label = String(c?.label ?? c?.name ?? 'Field')
        return { key: slugifyKey(label), label, type: String(c?.type ?? 'text') }
      })
      const { data, error } = await db.rpc('create_user_table', {
        p_name: name,
        p_columns: cols,
        p_visibility: visibility,
        p_owner: owner,
      })
      if (error) return text(`Error: ${error.message}`, true)
      const created = (Array.isArray(data) ? data[0] : data) as { name?: string } | null
      return text(`Created table "${created?.name ?? name}" (${visibility}). It's in the Tables dashboard.`)
    }
    case 'query_table': {
      const ref = String(args.table ?? '').trim()
      if (!ref) return text('query_table needs a table name.', true)
      const r = ref.toLowerCase()
      const t = (await ownerTables(db, owner)).find((x) => x.id === ref || x.name.trim().toLowerCase() === r)
      if (!t) return text(`No table named "${ref}" that you can access.`, true)
      let limit = Number(args.limit ?? 50)
      if (!Number.isFinite(limit) || limit <= 0) limit = 50
      limit = Math.min(Math.trunc(limit), 200)
      // deno-lint-ignore no-explicit-any
      let q: any = db.from(t.physical_name).select('*').limit(limit)
      const filters = (args.filters ?? null) as Record<string, unknown> | null
      if (filters && typeof filters === 'object') {
        const allowed = new Set((t.columns ?? []).map((c) => c.key).concat(['id', 'owner_id']))
        for (const [k, v] of Object.entries(filters)) if (allowed.has(k)) q = q.eq(k, v)
      }
      const { data, error } = await q
      if (error) return text(`Error: ${error.message}`, true)
      if (!data || !data.length) return text(`"${t.name}" has no matching rows.`)
      return text(`Rows from "${t.name}" (${data.length}):\n${JSON.stringify(data, null, 2)}`)
    }
    case 'add_table_row': {
      const ref = String(args.table ?? '').trim()
      const values = (args.values ?? null) as Record<string, unknown> | null
      if (!ref || !values || typeof values !== 'object') return text('add_table_row needs table and values.', true)
      const r = ref.toLowerCase()
      const t = (await ownerTables(db, owner)).find((x) => x.id === ref || x.name.trim().toLowerCase() === r)
      if (!t) return text(`No table named "${ref}" that you can access.`, true)
      const allowed = new Set((t.columns ?? []).map((c) => c.key))
      const row: Record<string, unknown> = { owner_id: owner }
      for (const [k, v] of Object.entries(values)) if (allowed.has(k)) row[k] = v
      const { error } = await db.from(t.physical_name).insert(row)
      if (error) return text(`Error: ${error.message}`, true)
      return text(`Added a row to "${t.name}".`)
    }
    case 'update_table_row': {
      const ref = String(args.table ?? '').trim()
      const values = (args.values ?? null) as Record<string, unknown> | null
      const match = (args.match ?? null) as Record<string, unknown> | null
      if (!ref || !values || typeof values !== 'object' || !Object.keys(values).length) {
        return text('update_table_row needs table and values.', true)
      }
      if (!match || typeof match !== 'object' || !Object.keys(match).length) {
        return text('update_table_row needs a "match" object identifying which row(s) to update.', true)
      }
      const r = ref.toLowerCase()
      const t = (await ownerTables(db, owner)).find((x) => x.id === ref || x.name.trim().toLowerCase() === r)
      if (!t) return text(`No table named "${ref}" that you can access.`, true)
      const allowed = new Set((t.columns ?? []).map((c) => c.key))
      const patch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(values)) if (allowed.has(k)) patch[k] = v
      if (!Object.keys(patch).length) return text('None of the given values match this table\'s columns.', true)
      const matchable = new Set([...allowed, 'id', 'owner_id'])
      // deno-lint-ignore no-explicit-any
      let q: any = db.from(t.physical_name).update(patch)
      let applied = 0
      for (const [k, v] of Object.entries(match)) if (matchable.has(k)) { q = q.eq(k, v); applied++ }
      if (!applied) return text(`None of the match columns exist on "${t.name}".`, true)
      const { data, error } = await q.select('id')
      if (error) return text(`Error: ${error.message}`, true)
      const count = Array.isArray(data) ? data.length : 0
      return text(count ? `Updated ${count} row${count === 1 ? '' : 's'} in "${t.name}".` : `No matching rows in "${t.name}".`)
    }
    case 'delete_table_row': {
      const ref = String(args.table ?? '').trim()
      const rowId = String(args.row_id ?? '').trim()
      if (!ref || !rowId) return text('delete_table_row needs table and row_id.', true)
      const r = ref.toLowerCase()
      const t = (await ownerTables(db, owner)).find((x) => x.id === ref || x.name.trim().toLowerCase() === r)
      if (!t) return text(`No table named "${ref}" that you can access.`, true)
      const { data, error } = await db.from(t.physical_name).delete().eq('id', rowId).select('id')
      if (error) return text(`Error: ${error.message}`, true)
      if (!data || !data.length) return text(`No row with id ${rowId} in "${t.name}" — nothing deleted.`, true)
      return text(`Deleted row ${rowId} from "${t.name}".`)
    }
    case 'list_loops':
      return text(await listLoopsText(db, owner))
    case 'create_loop': {
      const goal = String(args.goal ?? '').trim()
      if (!goal) return text('create_loop needs a goal (the prompt the loop optimizes toward).', true)
      let agentId = await resolveAgent(db, args.agent)
      if (!agentId) {
        if (args.agent) {
          return text(`No agent named "${args.agent}". Omit "agent" to use the default loop agent, or create_agent first.`, true)
        }
        agentId = await findOrCreateLoopAgent(db, owner)
      }
      const feedbackToolId = args.feedback_tool ? await resolveFeedbackTool(db, String(args.feedback_tool)) : null
      if (args.feedback_tool && !feedbackToolId) {
        return text(`No http tool named "${args.feedback_tool}" to use as the feedback source.`, true)
      }
      try {
        const loop = await createLoop(db, owner, {
          name: args.name,
          goal,
          rubric: args.rubric,
          max_iterations: args.max_iterations,
          budget_usd: args.budget_usd,
          target_score: args.target_score,
          agent_id: agentId,
          feedback_tool_id: feedbackToolId,
        })
        return text(`Created loop "${loop.name}" (id ${loop.id}). It's in the Loops dashboard — start it with run_loop "${loop.id}".`)
      } catch (err) {
        return text(`Error: ${err instanceof Error ? err.message : 'could not create the loop'}`, true)
      }
    }
    case 'run_loop': {
      const ref = String(args.loop ?? '').trim()
      if (!ref) return text('run_loop needs a loop (name or id).', true)
      const loop = await resolveLoop(db, owner, ref)
      if (!loop) return text(`No loop named "${ref}" that you can run.`, true)
      try {
        const { run_id } = await triggerLoopRun(loop.id, owner)
        return text(
          `Started loop "${loop.name}". Run id: ${run_id}. It iterates in the background until it hits its budget, iteration cap, target score, or converges. Check on it with get_loop_run "${run_id}".`,
        )
      } catch (err) {
        return text(`Error: ${err instanceof Error ? err.message : 'could not start the loop'}`, true)
      }
    }
    case 'get_loop_run': {
      const runId = String(args.run_id ?? '').trim()
      const loopRef = String(args.loop ?? '').trim()
      let run = null
      if (runId) run = await getRun(db, runId)
      else if (loopRef) {
        const loop = await resolveLoop(db, owner, loopRef)
        if (!loop) return text(`No loop named "${loopRef}" that you can access.`, true)
        run = await latestRunForLoop(db, loop.id)
      } else {
        return text('get_loop_run needs a run_id (from run_loop) or a loop name/id.', true)
      }
      if (!run) return text('No run found yet.', true)
      return text(formatRun(run))
    }
    default:
      return text(`Unknown tool: ${name}`, true)
  }
}

// Names of the tools this server implements directly (the build/authoring tools).
const STATIC_TOOL_NAMES = new Set(TOOLS.map((t) => t.name))

type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> }

// External MCP servers (Settings → External MCP) connect the workspace OUT to any
// MCP endpoint — e.g. a Playwright MCP for browser automation. Those remote tools
// already reach the internal agent loops; here we ALSO re-expose them through this
// server so an external Claude (Desktop / Code) that connects to the workspace gets
// Playwright & friends in the SAME tool list, alongside the build/authoring tools.
// Each active `kind='mcp'` tools row is a connected server; expandMcpTools discovers
// its (cached) toolset and returns namespaced specs + a router to execute them.
async function loadExternalTools(db: DB): Promise<{ tools: McpTool[]; router: McpRouter }> {
  const { data } = await db.from('tools').select('id, name, config').eq('kind', 'mcp').eq('is_active', true)
  const rows = (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    config: (r.config ?? {}) as { url?: string; server_id?: string },
  }))
  if (!rows.length) return { tools: [], router: new Map() }
  try {
    const { tools, router } = await expandMcpTools(db, rows)
    const mcpTools: McpTool[] = tools
      .filter((t) => t.type === 'function')
      .map((t) => {
        const fn = (t as { function: { name: string; description: string; parameters: Record<string, unknown> } }).function
        return { name: fn.name, description: fn.description, inputSchema: fn.parameters }
      })
    return { tools: mcpTools, router }
  } catch {
    return { tools: [], router: new Map() }
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
    case 'tools/list': {
      const ext = await loadExternalTools(db)
      return reply({ tools: [...TOOLS, ...ext.tools] })
    }
    case 'tools/call': {
      const name = params?.name as string
      const args = (params?.arguments as Record<string, unknown>) ?? {}
      try {
        // A namespaced name (‹server›__‹tool›) that isn't one of ours routes to the
        // connected external MCP server (e.g. Playwright) that provides it.
        if (!STATIC_TOOL_NAMES.has(name)) {
          const ext = await loadExternalTools(db)
          if (ext.router.has(name)) return reply(text(await runMcpTool(db, ext.router, name, args)))
        }
        return reply(await callTool(db, owner, name, args))
      } catch (err) {
        return reply(text(`Tool failed: ${err instanceof Error ? err.message : 'error'}`, true))
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`)
  }
})
