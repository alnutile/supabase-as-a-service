-- Combined size of several collections at once, for the chat "context window"
-- meter when more than one collection is scoped into a conversation.
--
-- Sums DISTINCT artifacts across the given collections, so an artifact that
-- belongs to two selected collections is counted once — matching what the chat
-- function actually injects (it dedupes too). SECURITY INVOKER: RLS applies as
-- the caller, so only visible memberships and readable artifacts are counted.

create or replace function public.collections_combined_chars(p_ids uuid[])
  returns bigint
  language sql
  stable
  security invoker
  set search_path = public
as $$
  select coalesce(sum(char_length(a.content)), 0)::bigint
  from (
    select distinct ca.artifact_id
    from public.collection_artifacts ca
    where ca.collection_id = any(p_ids)
  ) d
  join public.artifacts a on a.id = d.artifact_id
$$;

grant execute on function public.collections_combined_chars(uuid[]) to authenticated;
