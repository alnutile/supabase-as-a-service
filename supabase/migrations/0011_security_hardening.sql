-- Security review hardening.

-- 1) `tools` are admin-managed and their `config` can carry request headers
--    (a place secrets could live). Restrict reads to admins too — non-admins
--    never needed to read tool configs. (The chat/webhook/scheduler functions
--    read tools with the service role, which bypasses RLS.)
drop policy if exists "Members read tools" on public.tools;
create policy "Admins read tools"
  on public.tools for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- 2) cron_config holds the scheduler secret. RLS with no policy already denies
--    API access; revoke the default table grants too (defence in depth).
revoke all on public.cron_config from anon, authenticated;
