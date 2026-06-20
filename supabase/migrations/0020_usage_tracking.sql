-- Usage tracking: token + cost accounting for every model call.
--
-- The edge functions (chat, webhook, scheduler, guardrails) write one row per
-- OpenRouter call via recordUsage() (service role). The /usage page reads
-- aggregates through the usage_summary() RPC. RLS mirrors activity_log: a member
-- sees their own rows, an admin sees all; only the service role writes.

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  context text not null,                 -- chat | webhook | scheduler | guardrail
  model text not null,                   -- OpenRouter slug used for the call
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  cost numeric,                          -- USD credits (null when unreported)
  reasoning_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  actor_id uuid references auth.users (id) on delete set null,
  agent_id uuid references public.agents (id) on delete set null,
  detail jsonb,                          -- raw usage object (cost_details, etc.)
  created_at timestamptz not null default now()
);
create index usage_events_created_idx on public.usage_events (created_at desc);
create index usage_events_actor_idx on public.usage_events (actor_id, created_at desc);

alter table public.usage_events enable row level security;

create policy "Read own or admin all usage"
  on public.usage_events for select
  using (
    actor_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
-- No insert/update/delete policy: only the service role (edge functions) writes.

-- Aggregated spend for the /usage page. Admin-only (raises otherwise), so it can
-- summarize across the whole workspace. Returns one jsonb blob: totals plus
-- breakdowns by model / context / user and a daily series.
create or replace function public.usage_summary(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  since timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) then
    raise exception 'admin only';
  end if;

  select jsonb_build_object(
    'days', p_days,
    'total_cost', coalesce((select sum(cost) from public.usage_events where created_at >= since), 0),
    'total_tokens', coalesce((select sum(total_tokens) from public.usage_events where created_at >= since), 0),
    'total_calls', (select count(*) from public.usage_events where created_at >= since),
    'by_model', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select model, coalesce(sum(cost), 0) as cost, sum(total_tokens) as tokens, count(*) as calls
        from public.usage_events where created_at >= since
        group by model order by sum(cost) desc nulls last, count(*) desc
      ) t
    ), '[]'::jsonb),
    'by_context', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select context, coalesce(sum(cost), 0) as cost, sum(total_tokens) as tokens, count(*) as calls
        from public.usage_events where created_at >= since
        group by context order by sum(cost) desc nulls last
      ) t
    ), '[]'::jsonb),
    'by_user', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select e.actor_id, p.email,
               coalesce(sum(e.cost), 0) as cost, sum(e.total_tokens) as tokens, count(*) as calls
        from public.usage_events e
        left join public.profiles p on p.id = e.actor_id
        where e.created_at >= since
        group by e.actor_id, p.email order by sum(e.cost) desc nulls last
      ) t
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
               coalesce(sum(cost), 0) as cost, sum(total_tokens) as tokens
        from public.usage_events where created_at >= since
        group by date_trunc('day', created_at) order by date_trunc('day', created_at)
      ) t
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.usage_summary(integer) from public, anon;
grant execute on function public.usage_summary(integer) to authenticated;
