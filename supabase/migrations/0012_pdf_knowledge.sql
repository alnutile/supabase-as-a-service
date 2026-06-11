-- Stage 1 PDF knowledge base: parse the text layer of uploaded PDFs in the
-- background, embed the chunks for free with the in-edge `gte-small` model, and
-- store them in pgvector so the assistant can search them via a built-in tool.

create extension if not exists vector;

-- One row per PDF being indexed.
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  name text not null,
  status text not null default 'pending',   -- pending | processing | done | error
  error text,
  chunk_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_owner_idx on public.documents (owner_id);
create index documents_pending_idx on public.documents (status) where status = 'pending';

alter table public.documents enable row level security;
create policy "Owners manage their documents"
  on public.documents for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Chunks + embeddings (gte-small = 384 dims).
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  idx integer not null,
  content text not null,
  embedding vector(384),
  created_at timestamptz not null default now()
);
create index document_chunks_doc_idx on public.document_chunks (document_id);
create index document_chunks_owner_idx on public.document_chunks (owner_id);
create index document_chunks_embedding_idx on public.document_chunks using hnsw (embedding vector_cosine_ops);

alter table public.document_chunks enable row level security;
create policy "Owners read their chunks"
  on public.document_chunks for select
  using (owner_id = auth.uid());
-- Writes happen via the ingest function (service role); no client write policy.

-- Cosine-similarity search, scoped to one owner. Called by the chat function
-- (service role) with the requesting user's id; not exposed to API roles.
create or replace function public.match_document_chunks(
  query_embedding vector(384),
  match_owner uuid,
  match_count integer default 6
)
returns table (content text, document_id uuid, similarity float)
language sql stable
set search_path = public
as $$
  select dc.content, dc.document_id, 1 - (dc.embedding <=> query_embedding) as similarity
  from public.document_chunks dc
  where dc.owner_id = match_owner and dc.embedding is not null
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;
revoke execute on function public.match_document_chunks(vector, uuid, integer) from anon, authenticated, public;

-- Auto-enqueue every uploaded PDF for indexing.
create or replace function public.enqueue_document()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.mime_type = 'application/pdf' then
    insert into public.documents (owner_id, file_id, name) values (new.owner_id, new.id, new.name);
  end if;
  return new;
end; $$;
revoke execute on function public.enqueue_document() from anon, authenticated, public;

create trigger trg_enqueue_document
  after insert on public.files
  for each row execute function public.enqueue_document();

-- The search tool the assistant can call (tools-as-data; kind 'builtin').
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'search_documents',
  'Search the user''s uploaded PDF documents for relevant passages. Use whenever the user asks about the content of their files or documents.',
  '{"type":"object","properties":{"query":{"type":"string","description":"What to look for in the documents"}},"required":["query"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1);
