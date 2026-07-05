-- Files become AI-writable: the assistant (and external Claude via MCP) can now
-- CRUD the Files area, most importantly to PERSIST binary output it generates —
-- e.g. a base64 PNG from an image model — as a real, hosted, shareable file.
-- Previously the AI could generate an image but had no tool to store it or hand
-- it back as a clickable link (Artifacts/Links/Tables only take text or an
-- already-hosted URL).
--
-- Two additive columns on `files`:
--   * `tags`   — optional labels for filtering (list_files ?tag=).
--   * `source` — optional provenance jsonb, e.g. {"generator":"gpt-image-1",
--                "prompt":"…"}, so a generated file records how it was made.
-- Both are nullable, so the manual upload path (FilesPage) is unaffected.
--
-- The bottom seeds the `is_builtin` file tools (create_file / list_files /
-- get_file / delete_file / add_file_to_collection). Same insert shape as the
-- authoring/to-do/link builtins (0040/0041/0049); the shared executor lives in
-- supabase/functions/_shared/files.ts, so chat + the scheduler/webhook agent
-- loops AND the MCP server all run identical logic. Everything is owner-scoped
-- in code (files RLS is owner-only), reuses the private `files` bucket keyed by
-- `<owner>/<uuid>/<name>`, and returns a 7-day signed URL for sharing.

alter table public.files add column if not exists tags text[];
alter table public.files add column if not exists source jsonb;

-- ---------------------------------------------------------------------------
-- Seed the file builtins. Idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_file',
  'Create a file in the workspace Files area from base64 bytes OR plain text, and get back a shareable URL + file id. Use this to persist generated output — most importantly a base64 image (e.g. gpt-image-1 b64_json): pass content_base64 + filename + mime_type and hand the returned url to the user as a clickable link. Provide exactly one of content_base64 / content_text; max 10 MB; allowed types image/png|jpeg|webp|gif, application/pdf, text/plain, text/markdown, text/csv, application/json. PDFs are auto-indexed. Optionally file it into a collection (by name; created if missing) and set tags/source provenance.',
  '{"type":"object","properties":{"filename":{"type":"string","description":"Name including extension, e.g. diagram.png. Drives the content-type if mime_type is omitted."},"content_base64":{"type":"string","description":"Base64-encoded bytes (images, PDFs). One of content_base64 / content_text."},"content_text":{"type":"string","description":"Plain text/markdown content. One of content_base64 / content_text."},"mime_type":{"type":"string","description":"Defaults inferred from the extension."},"visibility":{"type":"string","enum":["private","workspace"],"description":"private (default) or workspace (link-shared)."},"collection":{"type":"string","description":"Optional collection name (or id) to file it into; created if missing."},"tags":{"type":"array","items":{"type":"string"},"description":"Optional tags."},"source":{"type":"object","description":"Optional provenance, e.g. {\"generator\":\"gpt-image-1\",\"prompt\":\"…\"}."}},"required":["filename"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_file');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_files',
  'List files in the Files area (metadata only). Filter by collection (name/id), tag, or mime_prefix (e.g. "image/"). limit default 50, max 200.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."},"tag":{"type":"string","description":"Optional tag to filter by."},"mime_prefix":{"type":"string","description":"Optional MIME prefix, e.g. image/ or application/pdf."},"limit":{"type":"number","description":"Max rows (default 50, max 200)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_files');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'get_file',
  'Get one file''s metadata and a fresh 7-day signed URL by id or filename. Set include_text=true to also return the text body of a small text/markdown file.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The file id."},"filename":{"type":"string","description":"Or the exact filename."},"include_text":{"type":"boolean","description":"Return content_text for small text files (default false)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'get_file');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'delete_file',
  'Delete a file by id (or filename): removes both the storage object and the Files row.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The file id."},"filename":{"type":"string","description":"Or the exact filename."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'delete_file');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_file_to_collection',
  'Add an existing file to a collection (both by name or id). The collection is created if it does not exist.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"file_id":{"type":"string","description":"The file id to add (or its filename)."}},"required":["collection","file_id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_file_to_collection');
