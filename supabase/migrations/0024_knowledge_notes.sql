-- Knowledge documents can come from a pushed note (not just an uploaded PDF).
--
-- A "document" is a unit of searchable knowledge in the workspace KB. Until now
-- every one was backed by a file in storage (a PDF, ingested by the `ingest`
-- cron). Now an external Claude can push raw text — e.g. Granola meeting notes —
-- straight into the KB via the `add_note` MCP tool, which chunks + embeds it
-- in-edge with gte-small and stores it like any other document. Such a document
-- has no underlying file, so `file_id` becomes optional and `source` records
-- where it came from.
--
-- Nothing about retrieval changes: notes default to scope = 'workspace' (the
-- table default), so the existing RLS + match_document_chunks already make them
-- searchable by every member's chat alongside PDFs.

alter table public.documents
  alter column file_id drop not null,
  add column source text not null default 'pdf'
    check (source in ('pdf', 'note'));

-- Nudge the assistant to reach for the search tool for meetings/notes too.
update public.tools
set description = 'Search the workspace''s shared knowledge base — uploaded documents plus pushed notes (e.g. meeting notes and transcripts) — and the user''s own private documents for relevant passages. Use whenever the user asks about the content of files, documents, meetings, or notes.'
where name = 'search_documents' and is_builtin;
