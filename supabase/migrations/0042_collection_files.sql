-- Collections become multi-content: in addition to artifacts, a collection can
-- now hold FILES (from the Files area). Chatting with the collection then grounds
-- the assistant in the artifacts AND the files together. This is the first of a
-- few content types (tables, knowledge docs follow) — each is just another join
-- table whose RLS inherits the collection's visibility, exactly like
-- collection_artifacts.

create table public.collection_files (
  collection_id uuid not null references public.collections (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, file_id)
);
create index collection_files_file_idx on public.collection_files (file_id);

alter table public.collection_files enable row level security;
grant select, insert, delete on public.collection_files to authenticated;

create policy "Read file memberships of visible collections"
  on public.collection_files for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

create policy "Add files to collaborable collections"
  on public.collection_files for insert
  with check (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

create policy "Remove files from collaborable collections"
  on public.collection_files for delete
  using (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

-- ---------------------------------------------------------------------------
-- Sizing: estimate a file's text size for the context-window meter.
--   * An indexed PDF/document → the actual extracted text (its chunk chars),
--     which is what the chat function injects.
--   * A plain-text-ish file → its byte size (≈ chars).
--   * Anything else (images, binaries) → 0; it isn't injected as text.
-- SECURITY INVOKER everywhere, so document_chunks RLS (owner or shared) applies.
-- ---------------------------------------------------------------------------
create or replace function public._file_chars(p_file uuid)
  returns bigint
  language sql
  stable
  security invoker
  set search_path = public
as $$
  select coalesce(
    (select sum(char_length(dc.content))::bigint
       from public.document_chunks dc
       join public.documents d on d.id = dc.document_id
      where d.file_id = p_file),
    (select case
        when f.mime_type like 'text/%'
          or f.mime_type in ('application/json', 'application/xml', 'application/csv', 'text/csv')
        then coalesce(f.size_bytes, 0)
        else 0
      end
       from public.files f where f.id = p_file),
    0
  )
$$;

-- Per-collection size now spans artifacts + files (the column name stays
-- `artifact_count` for compatibility but counts all items).
create or replace function public.collection_token_stats()
  returns table (collection_id uuid, artifact_count bigint, char_total bigint)
  language sql
  stable
  security invoker
  set search_path = public
as $$
  with items as (
    select ca.collection_id, char_length(a.content)::bigint as chars
    from public.collection_artifacts ca
    join public.artifacts a on a.id = ca.artifact_id
    union all
    select cf.collection_id, public._file_chars(cf.file_id) as chars
    from public.collection_files cf
  )
  select collection_id, count(*)::bigint as artifact_count, coalesce(sum(chars), 0)::bigint as char_total
  from items
  group by collection_id
$$;

-- Combined deduped size across several collections, spanning artifacts + files.
create or replace function public.collections_combined_chars(p_ids uuid[])
  returns bigint
  language sql
  stable
  security invoker
  set search_path = public
as $$
  select
    coalesce((
      select sum(char_length(a.content))
      from (select distinct ca.artifact_id from public.collection_artifacts ca where ca.collection_id = any(p_ids)) da
      join public.artifacts a on a.id = da.artifact_id
    ), 0)
    + coalesce((
      select sum(public._file_chars(df.file_id))
      from (select distinct cf.file_id from public.collection_files cf where cf.collection_id = any(p_ids)) df
    ), 0)
$$;

grant execute on function public._file_chars(uuid) to authenticated;
grant execute on function public.collection_token_stats() to authenticated;
grant execute on function public.collections_combined_chars(uuid[]) to authenticated;
