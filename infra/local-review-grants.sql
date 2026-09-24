-- Local-only compatibility for a fresh Supabase CLI database. Older migrations
-- assume hosted Supabase's API grants. Derive authenticated grants from the
-- existing RLS policies, rather than granting writes to every table.
do $$
declare p record; op text;
begin
  for p in select distinct tablename, cmd from pg_policies where schemaname = 'public'
    and ('authenticated' = any(roles) or 'public' = any(roles))
  loop
    op := case when p.cmd = 'ALL' then 'SELECT, INSERT, UPDATE, DELETE' else p.cmd end;
    execute format('grant %s on public.%I to authenticated', op, p.tablename);
  end loop;
end $$;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
notify pgrst, 'reload schema';
