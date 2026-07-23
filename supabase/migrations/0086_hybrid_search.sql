-- Hybrid knowledge-base retrieval: add a Postgres full-text (keyword) signal
-- alongside the existing pgvector (semantic) search, so `search_documents` can
-- fuse the two. Vector-only cosine search misses exact terms, IDs, names, and
-- rare tokens that never land near the query in embedding space; keyword search
-- catches those but misses paraphrases. Fusing both (reciprocal-rank fusion, done
-- in the edge function via _shared/retrieval.ts) is the retrieval-quality win.
--
-- No new infrastructure: Postgres native full-text (tsvector + GIN) is the
-- pragmatic BM25 stand-in — no extension, no external service. `match_document_chunks`
-- (0012/0013) is intentionally LEFT INTACT (the evals `rag` target still uses it);
-- this adds two focused, service-role-only RPCs that return chunk ids so the
-- caller can dedupe + fuse.

-- Keyword index: a generated, stored tsvector of each chunk's text. `to_tsvector`
-- with a literal regconfig is immutable, so it's valid in a generated column and
-- backfills existing rows during this ALTER. Inserts (ingest cron + ingestText)
-- never write this column — it's computed — so those paths are unaffected.
alter table public.document_chunks
  add column tsv tsvector generated always as (to_tsvector('english', content)) stored;

create index document_chunks_tsv_idx on public.document_chunks using gin (tsv);

-- Semantic candidates: same scope rule + cosine ordering as match_document_chunks,
-- but returns the chunk `id` (needed to dedupe against the keyword list) and a
-- larger default pool (fusion re-ranks, then the caller takes the top few).
create or replace function public.match_chunks_vector(
  query_embedding vector(384),
  match_owner uuid,
  match_count integer default 24
)
returns table (id uuid, content text, document_id uuid, document_name text, similarity float)
language sql stable
set search_path = public
as $$
  select dc.id, dc.content, dc.document_id, d.name as document_name,
         1 - (dc.embedding <=> query_embedding) as similarity
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where (d.scope = 'workspace' or dc.owner_id = match_owner)
    and dc.embedding is not null
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;
revoke execute on function public.match_chunks_vector(vector, uuid, integer) from anon, authenticated, public;

-- Keyword candidates: full-text ranking over the same scoped set. `websearch_to_tsquery`
-- parses a user-style query ("foo bar", quoted phrases, -negation); an empty/garbage
-- query yields an empty tsquery that matches nothing, so the caller gracefully
-- degrades to vector-only. ts_rank_cd is the cover-density rank (rewards proximity).
create or replace function public.match_chunks_keyword(
  query_text text,
  match_owner uuid,
  match_count integer default 24
)
returns table (id uuid, content text, document_id uuid, document_name text, rank float)
language sql stable
set search_path = public
as $$
  select dc.id, dc.content, dc.document_id, d.name as document_name,
         ts_rank_cd(dc.tsv, q) as rank
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id,
       websearch_to_tsquery('english', coalesce(query_text, '')) q
  where (d.scope = 'workspace' or dc.owner_id = match_owner)
    and dc.tsv @@ q
  order by ts_rank_cd(dc.tsv, q) desc
  limit match_count;
$$;
revoke execute on function public.match_chunks_keyword(text, uuid, integer) from anon, authenticated, public;
