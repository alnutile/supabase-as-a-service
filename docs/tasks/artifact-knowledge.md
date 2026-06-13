# Task: Index artifacts into the knowledge base (make context compound)

## Context

This app is a team intranet on Supabase. Today the assistant's knowledge base only
grows when someone uploads a PDF: a trigger on `files` enqueues a `documents` row, and
the `ingest` edge function (`supabase/functions/ingest/index.ts`, run by pg_cron)
extracts text, chunks it (`chunkText`), embeds each chunk with the free in-edge
`gte-small` model, and stores `document_chunks` in pgvector. The assistant searches
them via the built-in `search_documents` tool.

**The problem:** work *produced in* the system never feeds back into it. A proposal
drafted in chat and saved as an artifact is invisible to the next chat. The product's
core promise — "every piece of work makes the next one faster" — currently only holds
for uploaded PDFs.

**The goal:** artifacts are indexed into the same knowledge base, automatically, on
create and on edit. The proposal you made last week becomes context for the one you
write today.

**Depends on:** `docs/tasks/shared-knowledge.md` (adds `documents.scope` and widens
RLS + `match_document_chunks` to workspace scope). Implement that first if it isn't
merged yet.

## Design decisions (already made — don't relitigate)

- **Reuse `documents`/`document_chunks`**, not a parallel table set. One knowledge
  base, one search path, one status pipeline.
- **Artifact privacy follows artifact visibility.** An artifact marked **Private** is
  indexed with `scope = 'private'` (searchable only by its owner — it still compounds
  for them). **Unlisted/Public** artifacts get `scope = 'workspace'`. The UI promise
  "Private" must never silently leak content to teammates, so we do not default
  artifact knowledge to workspace the way we do for uploaded PDFs.
- Index **all artifact types** (markdown, text, code, html) as plain text. Smarter
  handling (HTML tag stripping, code-aware chunking) is out of scope.

## Requirements

### 1. Schema (new migration, next number in `supabase/migrations/`)

- Generalize `public.documents`:
  - `source text not null default 'file' check (source in ('file','artifact'))`
  - `file_id` becomes nullable; add
    `artifact_id uuid references public.artifacts (id) on delete cascade`
  - Check constraint: `source = 'file'` ⇒ `file_id is not null`;
    `source = 'artifact'` ⇒ `artifact_id is not null`
  - `create unique index ... on documents (artifact_id) where artifact_id is not null`
    (one knowledge row per artifact)
- New trigger function `enqueue_artifact()` (security definer, pinned `search_path`,
  execute revoked from API roles — match the style of `enqueue_document()` in
  `0012_pdf_knowledge.sql`):
  - AFTER INSERT on `artifacts`: if `length(trim(new.content)) >= 50`, insert a
    `documents` row (`source = 'artifact'`, `name = new.title`,
    `scope = case when new.visibility = 'private' then 'private' else 'workspace' end`,
    status `pending`).
  - AFTER UPDATE on `artifacts`, only
    `when (old.content is distinct from new.content
           or old.title is distinct from new.title
           or old.visibility is distinct from new.visibility)`:
    upsert the document row — refresh `name` and `scope` from the artifact, set
    `status = 'pending'` so the next ingest tick re-chunks it. (Content shorter than
    50 chars: set the row to `done` with `chunk_count = 0` and delete its chunks, or
    skip creating one.)
  - Deleting an artifact needs no trigger — the FK cascade removes the document and
    its chunks.
- Backfill: enqueue existing artifacts (insert pending `documents` rows following the
  same visibility→scope mapping and length rule). The cron tick will drain them at
  `DOCS_PER_RUN` per minute — that's acceptable.
- Update the seeded `search_documents` tool description: it searches the workspace
  knowledge base — uploaded documents **and artifacts created in the workspace** —
  plus the user's private items.

### 2. Ingest function (`supabase/functions/ingest/index.ts`)

- Select `source, artifact_id` along with the existing columns when draining pending
  docs.
- Branch per doc:
  - `source = 'file'`: existing PDF path, unchanged.
  - `source = 'artifact'`: fetch `title, content` from `artifacts` by `artifact_id`
    (service role); the text to index is `` `${title}\n\n${content}` ``. No storage
    download, no unpdf. Reuse `chunkText`, the delete-then-insert chunk replacement,
    the `done`/`error` status updates, and the `activity_log` entry (use a
    distinguishable summary, e.g. "Indexed artifact ‹title› (n chunks)").
- Keep the function's contract unchanged otherwise (cron secret gate, `DOCS_PER_RUN`,
  response shape).

### 3. Chat function / search

- No structural change needed — `match_document_chunks` (post shared-knowledge task)
  already joins `documents` and returns `document_name`, so artifact chunks surface
  with their titles. Verify artifact-sourced results read well in the tool output.

### 4. Types & docs

- Update `src/lib/database.types.ts` for the new `documents` columns (regenerate or
  hand-edit to match, per CLAUDE.md convention).
- Update the RAG paragraph in `CLAUDE.md` and the README knowledge bullet: the
  knowledge base now includes artifacts, indexed on create/edit, scope follows
  artifact visibility.

## Acceptance criteria

1. User A creates a non-private artifact → after the next cron tick, user B's chat can
   answer questions from it via `search_documents`, citing the artifact title.
2. User A edits that artifact's content → it re-indexes (status returns to `pending`,
   then `done`; old chunks replaced, no duplicates).
3. A **Private** artifact is searchable by its owner but never by user B; flipping it
   to Unlisted makes it searchable by user B after re-index, and flipping back to
   Private removes it from user B's results.
4. Renaming an artifact updates the cited `document_name`.
5. Deleting an artifact removes its document row and chunks (FK cascade).
6. Saving an artifact with no content change (e.g. only `updated_at` touched) does
   **not** re-enqueue it.
7. Pre-existing artifacts get indexed by the backfill without manual action.
8. `npm run build` and `npm run lint` pass.

## Out of scope (do not build now)

Indexing chat conversations or messages, HTML tag stripping, code-aware chunking,
embedding-model changes, an indexing-status UI on the artifacts pages, debouncing
rapid successive edits (the pending-flag upsert already coalesces them), and any
change to chunk size constants.

## Constraints

- RLS is the security boundary — scope must be enforced by the policies and the SQL
  function from the shared-knowledge task, never by app-side filtering alone.
- Follow existing migration style: comments, pinned `search_path` on trigger
  functions, explicit `revoke execute` from API roles.
- The ingest function must stay idempotent per document (safe to re-run on the same
  pending row).
