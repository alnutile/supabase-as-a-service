-- Per-collection size stats so the UI can show how much of the model's context
-- window a collection would fill before you chat with it.
--
-- SECURITY INVOKER (the default for SQL functions): RLS applies as the CALLER,
-- so the sums only count membership rows in collections the caller can see and
-- artifacts the caller can read (own or non-private) — exactly the set the chat
-- function injects. Returns raw character totals; the client derives an estimated
-- token count (~4 chars/token), since there is no single correct tokenizer.

create or replace function public.collection_token_stats()
  returns table (collection_id uuid, artifact_count bigint, char_total bigint)
  language sql
  stable
  security invoker
  set search_path = public
as $$
  select ca.collection_id,
         count(*)::bigint as artifact_count,
         coalesce(sum(char_length(a.content)), 0)::bigint as char_total
  from public.collection_artifacts ca
  join public.artifacts a on a.id = ca.artifact_id
  group by ca.collection_id
$$;

grant execute on function public.collection_token_stats() to authenticated;
