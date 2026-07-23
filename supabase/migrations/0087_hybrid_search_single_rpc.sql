-- Consolidate hybrid retrieval into ONE round trip.
--
-- 0086 shipped hybrid search as two RPCs (match_chunks_vector + match_chunks_keyword)
-- fused in the edge function, and the `rag` eval additionally called
-- match_document_chunks for its vector-only baseline — so a rag A/B case made THREE
-- retrieval round trips plus an embedding. On larger suites that per-case chattiness
-- tipped the edge worker over its budget mid-run (runs stalled ~13 cases in). This
-- single RPC returns the candidate pool with each chunk's vector-rank AND keyword-rank
-- in one call; the caller fuses (RRF) and also reads the vector-only order off the same
-- rows. Net: the live search_documents path goes 2 round trips → 1, and the rag A/B
-- goes 3 → 1. It also returns document_updated_at so citations can show recency
-- ("think" mode: cite + staleness).
--
-- Index-friendly: each signal's inner subquery is a plain `ORDER BY <op> LIMIT`, so
-- pgvector's HNSW index (vec) and the GIN tsv index (kw) are still used; the outer
-- row_number() only ranks the already-limited top-N set. Same scope rule as before
-- (workspace ∪ caller's private), service-role only.
--
-- The two 0086 RPCs are left in place (now unused by the edge code, harmless) to keep
-- this migration additive and non-breaking.

create or replace function public.search_chunks_hybrid(
  query_embedding vector(384),
  query_text text,
  match_owner uuid,
  match_count integer default 24
)
returns table (
  id uuid,
  content text,
  document_id uuid,
  document_name text,
  document_updated_at timestamptz,
  vec_rank integer,
  kw_rank integer
)
language sql stable
set search_path = public
as $$
  with vec as (
    -- inner ORDER BY <=> LIMIT lets pgvector use the HNSW index; the outer
    -- row_number ranks the small top-N set by cosine distance.
    select id, row_number() over (order by dist) as vec_rank
    from (
      select dc.id, (dc.embedding <=> query_embedding) as dist
      from public.document_chunks dc
      join public.documents d on d.id = dc.document_id
      where (d.scope = 'workspace' or dc.owner_id = match_owner)
        and dc.embedding is not null
      order by dc.embedding <=> query_embedding
      limit match_count
    ) v
  ),
  kw as (
    -- inner tsv @@ tsq + ORDER BY ts_rank_cd LIMIT uses the GIN index; an empty
    -- query yields an empty tsquery → no rows → graceful degrade to vector-only.
    select id, row_number() over (order by rnk desc) as kw_rank
    from (
      select dc.id, ts_rank_cd(dc.tsv, q.tsq) as rnk
      from public.document_chunks dc
      join public.documents d on d.id = dc.document_id,
           websearch_to_tsquery('english', coalesce(query_text, '')) q(tsq)
      where (d.scope = 'workspace' or dc.owner_id = match_owner)
        and dc.tsv @@ q.tsq
      order by ts_rank_cd(dc.tsv, q.tsq) desc
      limit match_count
    ) k
  ),
  ids as (select id from vec union select id from kw)
  select dc.id, dc.content, dc.document_id, d.name as document_name,
         d.updated_at as document_updated_at,
         v.vec_rank::integer, k.kw_rank::integer
  from ids
  join public.document_chunks dc on dc.id = ids.id
  join public.documents d on d.id = dc.document_id
  left join vec v on v.id = ids.id
  left join kw k on k.id = ids.id;
$$;
revoke execute on function public.search_chunks_hybrid(vector, text, uuid, integer) from anon, authenticated, public;
