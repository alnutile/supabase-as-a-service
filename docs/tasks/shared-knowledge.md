# Task: Make PDF knowledge workspace-shared by default

## Context

This app is a team intranet on Supabase. Uploaded PDFs are indexed into a pgvector
knowledge base (`documents` + `document_chunks`, migration
`supabase/migrations/0012_pdf_knowledge.sql`) and the assistant searches them via the
built-in `search_documents` tool (`runBuiltin()` in `supabase/functions/chat/index.ts`,
~line 199), which calls the `match_document_chunks` SQL function.

**The problem:** everything is scoped to the uploader. `match_document_chunks` filters
`dc.owner_id = match_owner`, and RLS on both tables is owner-only. So if the workspace
admin uploads the company's proposals, no one else's chats can search them. That breaks
the core product promise (a shared team knowledge base).

**The goal:** documents are part of the **workspace knowledge base by default**, with a
per-document "Only me" opt-out. Privacy is the exception, sharing is the rule.

## Requirements

### 1. Schema (new migration, next number in `supabase/migrations/`)

- Add `scope text not null default 'workspace' check (scope in ('workspace','private'))`
  to `public.documents`.
- Backfill: leave **existing** rows as `'private'` (set explicitly in the migration).
  They were uploaded under owner-only semantics; retroactive sharing is a privacy
  surprise. New rows get the `'workspace'` default. (Maintainer may decide to flip the
  backfill — make it a clearly-marked single line.)
- RLS updates:
  - `documents`: keep "owners manage their documents" (ALL). Add a SELECT policy letting
    any authenticated user read rows where `scope = 'workspace'`.
  - `document_chunks`: replace the owner-only SELECT policy with
    owner **or** parent document has `scope = 'workspace'` (use an `exists` subquery
    against `documents`).
  - Only the owner may change a document's scope (covered by the existing ALL policy —
    do not add an UPDATE policy for non-owners).
- Update `match_document_chunks(query_embedding, match_owner, match_count)`:
  - Join `documents d on d.id = dc.document_id`.
  - Filter: `(d.scope = 'workspace' or dc.owner_id = match_owner)`.
  - Also return `d.name` as `document_name` so the assistant can cite sources.
  - Keep `language sql stable`, pinned `search_path`, and the
    `revoke execute ... from anon, authenticated, public` (it's service-role-only).
- Update the seeded `search_documents` tool row's `description` (via
  `update public.tools set description = ... where name = 'search_documents' and is_builtin`):
  it now searches "the workspace's shared knowledge base plus the user's private
  documents", not just "the user's uploaded PDF documents".

### 2. Chat edge function (`supabase/functions/chat/index.ts`)

- In `runBuiltin()`, the `match_document_chunks` RPC call doesn't change shape
  (still passes `match_owner: userId`), but update the result formatting to include the
  document name, e.g. `[1] (Proposal_Henderson.pdf) …chunk text…`.
- Update the comment above `runBuiltin` to describe the new scope semantics.

### 3. Files UI (`src/pages/FilesPage.tsx`)

- For each indexed PDF (the page already loads `documents` rows and live-updates status
  over Realtime), show its scope and let the **owner** toggle it:
  "Team knowledge" ⇄ "Only me" — a small inline control next to the existing indexing
  status, consistent with the page's existing styling. Persist via
  `supabase.from('documents').update({ scope })`.
- Default state for new uploads will be "Team knowledge" (from the DB default) — make
  sure the UI reflects that immediately after upload.
- Note: this scope is **separate** from the existing `files.visibility` (which controls
  signed-link sharing of the raw file). Do not merge the two. The raw PDF in storage
  stays in the owner's private bucket path; only the extracted text chunks are shared.

### 4. Types & docs

- Regenerate or hand-edit `src/lib/database.types.ts` to add `documents.scope` (the
  project convention allows hand-editing to match the migration — see CLAUDE.md).
- Update the RAG paragraphs in `CLAUDE.md` and the README feature bullet to say
  knowledge is workspace-shared by default with a per-document private toggle.

## Acceptance criteria

1. User A uploads a PDF → after indexing, user B's chat can answer questions from it via
   `search_documents` (and the answer cites the document name).
2. User A flips that document to "Only me" → user B's searches no longer return its
   chunks; user A's still do.
3. A document uploaded **before** this migration is not searchable by user B until its
   owner flips it to "Team knowledge".
4. User B cannot change the scope of user A's document (RLS blocks the update).
5. User B still cannot download user A's raw file from storage (unchanged).
6. `npm run build` and `npm run lint` pass.

## Out of scope (do not build now)

Workspace-shared *files* (raw blobs), a separate "Knowledge" page listing all team
documents, admin override of scopes, sharing for non-PDF content, and chunk-level
permissions.

## Constraints

- RLS is the security boundary — implement sharing in policies and the SQL function,
  never by widening service-role reads in app code.
- Follow existing migration style (comments, pinned `search_path`, explicit revokes).
- Keep the edge-function change minimal; no streaming-protocol changes.
