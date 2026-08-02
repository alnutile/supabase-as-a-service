-- Skill usage logging.
--
-- Records one row per on-demand skill run so the Skills page can show
-- "used N times / last used …" and a future job can prune skills that have gone
-- stale. Only on-demand runs (ChatPage.runSkill) are recorded — always-on
-- prompts (auto_apply = true) load on EVERY chat message, so counting them as
-- per-skill "uses" would be pure noise and misattributed.
--
-- Follows the activity_log / usage_events pattern: own-or-admin SELECT, and no
-- insert policy — rows are written only by the SECURITY DEFINER record_skill_run
-- RPC (the run happens client-side under the user's JWT, so there's no
-- service-role round-trip to write from).

create table if not exists public.skill_runs (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references public.skills (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists skill_runs_skill_created_idx
  on public.skill_runs (skill_id, created_at desc);
create index if not exists skill_runs_created_idx
  on public.skill_runs (created_at desc);

alter table public.skill_runs enable row level security;

-- Read own or admin-all, mirroring activity_log / usage_events. A member sees
-- their own skill usage; an admin sees everything (the ops view for pruning).
drop policy if exists "skill_runs read own or admin" on public.skill_runs;
create policy "skill_runs read own or admin" on public.skill_runs
  for select using (
    actor_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin
    )
  );

-- Realtime so the Skills page reflects new runs live. Idempotent so a re-apply
-- after any partial state is a no-op (see the 0107/0108 collision post-mortem).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'skill_runs'
  ) then
    alter publication supabase_realtime add table public.skill_runs;
  end if;
end $$;

-- Record one skill run. SECURITY DEFINER so the client can insert without an
-- INSERT policy; the caller can only ever attribute a run to themselves
-- (actor_id = auth.uid()), and only for a skill they can actually see (their own
-- or an always-on prompt), so skills' RLS is still honored.
create or replace function public.record_skill_run(p_skill_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;
  if not exists (
    select 1 from public.skills s
    where s.id = p_skill_id
      and (s.owner_id = auth.uid() or s.auto_apply = true)
  ) then
    return;  -- unknown / not-visible skill: silently no-op
  end if;
  insert into public.skill_runs (skill_id, actor_id)
  values (p_skill_id, auth.uid());
end;
$$;

revoke all on function public.record_skill_run(uuid) from public;
grant execute on function public.record_skill_run(uuid) to authenticated;

-- Per-skill aggregates for the Skills page + any prune tooling: run_count and
-- last_used_at. SECURITY INVOKER so skill_runs' own-or-admin RLS applies — a
-- member aggregates only their own runs, an admin aggregates everyone's.
create or replace function public.skill_usage_stats()
returns table (skill_id uuid, run_count bigint, last_used_at timestamptz)
language sql
security invoker
stable
as $$
  select r.skill_id, count(*)::bigint as run_count, max(r.created_at) as last_used_at
  from public.skill_runs r
  group by r.skill_id;
$$;

grant execute on function public.skill_usage_stats() to authenticated;
