# Task: Let the MCP server upload files (into Files + the knowledge base)

## Context

The MCP server (`supabase/functions/mcp/index.ts`) exposes build tools (`create_agent`,
`create_http_tool`, `create_skill`, `create_webhook`, `create_artifact`, `list_*`).
`create_artifact` is **text-only** (markdown/code/html/text). There is no way for an
external Claude to push a **file** — a PDF, image, or other binary — into the workspace.

Files normally arrive through the web UI: upload to the private `files` storage bucket
under `‹owner›/…`, insert a `files` row; a trigger then enqueues PDFs into the knowledge
base (`documents` → `ingest` → pgvector). So "upload via MCP" means doing those same two
steps server-side as the token's owner.

**The goal:** an external Claude (e.g. Claude Code, which can read local files) can push
files into the workspace's Files area over MCP — and PDFs land in the shared knowledge
base automatically, exactly as a UI upload would.

## Design decisions (already made — don't relitigate)

- **Two tools, a small-file path and a large-file path**, because MCP arguments are JSON
  and binaries don't belong inline past a few MB:
  1. `upload_file` — inline **base64** content, for files up to a hard cap (**10 MB** of
     decoded bytes). Simplest; covers most PDFs/images/text. This is the primary tool.
  2. `create_file_upload` + `finalize_file_upload` — a **signed-URL** pair for larger
     files: the first returns a Supabase Storage signed **upload** URL + the storage
     path; the calling agent PUTs the bytes directly to that URL (bypassing the edge
     function body limit); the second inserts the `files` row. Mark this pair clearly in
     tool descriptions as "for files over ~10 MB / when you can do an HTTP PUT."
- **Runs as the token owner.** All writes use the service-role client but must target
  `‹owner_id›/‹uuid›/‹name›` and set `files.owner_id = owner`, matching the storage
  policy and how the UI does it. Never write outside the owner's folder.
- **Reuse the existing pipeline.** Inserting the `files` row is enough — the existing
  `enqueue_document` trigger handles PDF indexing; do **not** re-implement ingestion.
  Files default to `visibility: 'private'` (the raw blob stays owner-private; PDF *text*
  becomes workspace knowledge via the shared-knowledge default — that's already correct).
- **Validate inputs.** Require `name` and `mime_type`; cap decoded size; reject empty
  content. On base64 decode failure return a clear MCP error (`isError`), not a crash.

## Requirements

### 1. `upload_file` tool (`supabase/functions/mcp/index.ts`)

- Add to `TOOLS`:
  - `name`: `upload_file`
  - description: "Upload a file (PDF, image, text, etc.) into the workspace Files area.
    PDFs are automatically indexed into the shared knowledge base. Provide the content
    base64-encoded; max 10 MB."
  - inputSchema: `{ name: string (required), mime_type: string (required),
    content_base64: string (required) }`.
- In `callTool`, handle `upload_file`:
  1. Decode base64; if it fails or decoded length > 10 MB, return `text(..., true)` with
     a clear message.
  2. `path = ` `${owner}/${crypto.randomUUID()}/${name}`.
  3. `db.storage.from('files').upload(path, bytes, { contentType: mime_type })`.
  4. Insert `files` row: `{ owner_id: owner, bucket: 'files', path, name,
     mime_type, size_bytes: bytes.length, visibility: 'private' }`.
  5. Return a short confirmation, noting indexing for PDFs (e.g. "Uploaded ‹name›. PDFs
     are being indexed into the knowledge base.").
- Log an `activity_log` row (type e.g. `file.uploaded`, actor = owner) consistent with
  how UI uploads surface in Activity, if the UI path logs one (match existing behavior;
  don't double-log if the trigger already does).

### 2. Signed-URL pair (same file)

- `create_file_upload(name, mime_type)` → compute the same `‹owner›/‹uuid›/‹name›` path,
  create a Storage **signed upload URL** (`createSignedUploadUrl`), and return the URL +
  path + token in the text result so the agent can PUT the bytes. (Do not insert the
  `files` row yet.)
- `finalize_file_upload(path, name, mime_type, size_bytes)` → verify the path is under
  `‹owner›/…` (reject otherwise), confirm the object exists, then insert the `files`
  row exactly as in step 1.4. This triggers indexing for PDFs.
- Keep these clearly secondary in their descriptions so the model reaches for
  `upload_file` by default and only uses the pair for large files.

### 3. Docs

- README MCP bullet + CLAUDE.md MCP paragraph: note the server can now upload files
  (small files inline via `upload_file`, large files via the signed-URL pair) and that
  PDFs auto-index into the knowledge base.

## Acceptance criteria

1. From Claude Code connected over MCP, `upload_file` with a small PDF's base64 creates
   a `files` row owned by the token owner, the blob lands under `‹owner›/…`, and within a
   cron tick or two the PDF appears in `documents`/`document_chunks` (searchable via
   `search_documents`).
2. The uploaded file shows in the web UI Files list for that owner, blob private.
3. A >10 MB `upload_file` is rejected with a clear message (no crash); the signed-URL
   pair handles a large file end to end.
4. `finalize_file_upload` refuses a path outside the caller's `‹owner›/…` folder.
5. A non-PDF (e.g. PNG) uploads fine and simply isn't indexed (no error).
6. Bad base64 returns an MCP error result, not a 500.
7. No regression to existing MCP tools.

## Out of scope (do not build now)

Virus scanning, image/scanned-PDF OCR (that's the vision Stage-2 item), per-upload
visibility/scope arguments (default private blob + workspace knowledge is correct),
deleting/listing files over MCP, chunking very large non-PDF text, and multi-file batch
calls.

## Constraints

- Writes run as the token owner and stay within `‹owner›/…`; never widen beyond that.
- Reuse the existing `enqueue_document` trigger / `ingest` pipeline — no parallel
  ingestion path.
- Keep the MCP server stateless JSON-RPC (no SSE); match its existing `text()` /
  `isError` result helpers and CORS.
- Respect Supabase edge request body limits — that's the whole reason the signed-URL
  pair exists for large files; don't try to push 50 MB through `upload_file`.
