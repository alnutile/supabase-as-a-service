-- Live Features board: put `features` in the supabase_realtime publication so
-- the kanban updates as it happens instead of only on reload. The board syncs
-- PR state (pr_url/pr_number/pr_state) in the background via the `features` edge
-- function; without realtime the freshly-synced PR link only appears after a
-- manual page reload (issue #104). Idempotent, matching 0054/0058.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'features'
  ) then
    alter publication supabase_realtime add table public.features;
  end if;
end $$;
