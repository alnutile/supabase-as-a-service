-- Agent runs & steps — an observability trace for one invocation of an agent.
--
-- NOTE: renumbered from a colliding 0107 that clashed with main's
-- 0107_slack_message_builtin.sql (landed by the Slack-listener PR while this was
-- in review) — prod recorded version 0107 from that file, so the duplicate-prefix
-- 0107_agent_runs could never apply and `db push` failed on the collision. Made
-- idempotent (create-if-not-exists everywhere + guarded publication adds) so
-- re-applying against a workspace that partially has these objects is a no-op.
--
-- The four agent loops (chat, scheduler, webhook, slack) run a model→tool→model
-- loop but persist almost nothing per step: a tool call logged only the tool NAME
-- to activity_log, usage_events had no run/conversation grouping, and the
-- orchestrator's in-memory trace was thrown away. This is the "blind place back
-- there" — you can't troubleshoot what an unattended agent actually did.
--
-- `agent_runs` is one row per invocation (header: surface, status, totals,
-- final output); `agent_run_steps` is one row per step (model turn or tool call,
-- with the tool's raw input/output). Steps are rows (not a jsonb blob) so a
-- builder can filter — "runs that called send_email", "runs with a tool error".
--
-- Visibility: owner (the run initiator — who it ran AS) + admins, matching
-- usage_events/activity_log. Step input/output can hold sensitive payloads (a
-- webhook body, someone's chat), so it's deliberately NOT workspace-wide. Writes
-- are service-role only (the loops run as the service role, bypassing RLS); there
-- are no INSERT/UPDATE policies on purpose.

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  surface text not null,                       -- chat | schedule | webhook | slack | listener | manual
  trigger_ref jsonb not null default '{}'::jsonb, -- {conversation_id|schedule_id|webhook_event_id|slack_event_id}
  status text not null default 'running',      -- running | done | error
  model text,
  input text,                                  -- the triggering input/payload (truncated)
  final_output text,                           -- final assistant text (truncated)
  error text,
  turns int not null default 0,                -- model round-trips
  tool_calls int not null default 0,
  total_tokens int not null default 0,
  cost numeric not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists agent_runs_agent_started_idx on public.agent_runs (agent_id, started_at desc);
create index if not exists agent_runs_owner_started_idx on public.agent_runs (owner_id, started_at desc);

create table if not exists public.agent_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  seq int not null,                            -- order within the run
  kind text not null,                          -- model | tool
  tool_name text,                              -- for tool steps
  input jsonb,                                 -- tool arguments (tool steps)
  output text,                                 -- tool result OR model assistant text (truncated)
  error text,
  sandboxed boolean not null default false,
  tokens int,
  cost numeric,
  duration_ms int,
  created_at timestamptz not null default now()
);

create index if not exists agent_run_steps_run_seq_idx on public.agent_run_steps (run_id, seq);

alter table public.agent_runs enable row level security;
alter table public.agent_run_steps enable row level security;

-- Owner-or-admin read; no write policies → only the service role writes.
drop policy if exists "agent_runs read own or admin" on public.agent_runs;
create policy "agent_runs read own or admin" on public.agent_runs
  for select using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "agent_run_steps read via run" on public.agent_run_steps;
create policy "agent_run_steps read via run" on public.agent_run_steps
  for select using (
    exists (
      select 1 from public.agent_runs r
      where r.id = agent_run_steps.run_id
        and (
          r.owner_id = auth.uid()
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

-- Realtime so the detail page ticks a running agent's steps live (same pattern as
-- security_scans / loop_runs / event_listener_runs). Guarded so a re-apply after a
-- partial run doesn't fail with "relation is already member of publication".
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_runs'
  ) then
    alter publication supabase_realtime add table public.agent_runs;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_run_steps'
  ) then
    alter publication supabase_realtime add table public.agent_run_steps;
  end if;
end $$;
