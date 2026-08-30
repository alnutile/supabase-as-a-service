-- Live to-dos: publish `todos` and `collection_todos` over Realtime.
--
-- To-dos are a collaborative surface — a `workspace` row is one every member
-- can check off, reorder and now drag between lanes — but the page only ever
-- read them once, on mount. Two people working the same board saw diverging
-- state until somebody reloaded, which for drag-and-drop is worse than it
-- sounds: you drag a card to Doing, a teammate drags the same card to Blocked,
-- and neither of you learns the other moved it.
--
-- Publishing the tables lets TodosPage subscribe to postgres_changes and merge
-- rows as they land, the same pattern ChatPage/ArtifactsPage/KnowledgePage
-- already use. RLS still applies to the stream: Realtime evaluates the SELECT
-- policy per subscriber, so a private to-do is never broadcast to anyone but
-- its owner (and admins) — publishing a table does NOT widen who can read it.
--
-- `collection_todos` rides along because the board renders each card's
-- collection tokens and the picker's counts come from membership; filing a
-- to-do into a collection has to reach the other tabs too.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'todos'
  ) then
    alter publication supabase_realtime add table public.todos;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'collection_todos'
  ) then
    alter publication supabase_realtime add table public.collection_todos;
  end if;
end $$;

-- DELETE events carry only the replica identity, which defaults to the primary
-- key — enough to drop the row from a peer's list, but Realtime also needs the
-- full row to evaluate the SELECT policy before it forwards a delete. Without
-- this a deleted to-do lingers on every other screen until a reload, which is
-- the one change a collaborator most needs to see. The extra WAL is a handful
-- of short columns per write.
alter table public.todos replica identity full;
alter table public.collection_todos replica identity full;
