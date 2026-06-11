-- PDF knowledge becomes workspace-shared by default.
--
-- Each document has a `scope`: 'workspace' (any signed-in member's chat can
-- search its chunks) or 'private' (owner only). New uploads default to
-- 'workspace' — sharing is the rule, privacy the opt-out. Only the extracted
-- text chunks are shared; the raw PDF blob in storage stays owner-private
-- regardless (that's governed separately by files.visibility + storage policies).

alter table public.documents
  add column scope text not null default 'workspace'
    check (scope in ('workspace', 'private'));

-- Existing documents were uploaded under owner-only semantics — keep them
-- private so nothing is retroactively shared by surprise. Their owners can flip
-- them to "Team knowledge" in the UI.
-- (Flip this single line to set scope = 'workspace' if you'd rather share all
-- pre-existing documents.)
update public.documents set scope = 'private';

-- documents: owners still manage their own (existing ALL policy); everyone may
-- read workspace-scoped rows. Only the owner can change a document's scope —
-- that's covered by the ALL policy, so no non-owner UPDATE policy is added.
create policy "Members read workspace documents"
  on public.documents for select
  using (scope = 'workspace' and auth.uid() is not null);

-- document_chunks: readable by the owner, or when the parent document is shared.
drop policy "Owners read their chunks" on public.document_chunks;
create policy "Read own or workspace chunks"
  on public.document_chunks for select
  using (
    owner_id = auth.uid()
    or exists (
      select 1 from public.documents d
      where d.id = document_id and d.scope = 'workspace'
    )
  );

-- Search across the workspace knowledge base plus the caller's private docs, and
-- return the document name so the assistant can cite sources.
drop function if exists public.match_document_chunks(vector, uuid, integer);
create function public.match_document_chunks(
  query_embedding vector(384),
  match_owner uuid,
  match_count integer default 6
)
returns table (content text, document_id uuid, document_name text, similarity float)
language sql stable
set search_path = public
as $$
  select dc.content, dc.document_id, d.name as document_name,
         1 - (dc.embedding <=> query_embedding) as similarity
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where (d.scope = 'workspace' or dc.owner_id = match_owner)
    and dc.embedding is not null
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;
revoke execute on function public.match_document_chunks(vector, uuid, integer) from anon, authenticated, public;

update public.tools
set description = 'Search the workspace''s shared knowledge base plus the user''s own private documents for relevant passages. Use whenever the user asks about the content of files or documents.'
where name = 'search_documents' and is_builtin;
