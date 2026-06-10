-- Scheduled agents: run an agent on an interval. A pg_cron job ticks every
-- minute and calls the `scheduler` edge function (authed by a DB-stored secret
-- via pg_net); the function runs any agents whose schedule is due.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Shared secret the cron job sends and the scheduler function checks. RLS on
-- with no policies → unreachable from the API; only postgres/service role read it.
create table public.cron_config (secret text not null);
alter table public.cron_config enable row level security;
insert into public.cron_config (secret)
  values (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  input text not null default '',          -- the message the agent runs on each tick
  interval_minutes integer not null default 1440,
  is_active boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index schedules_due_idx on public.schedules (next_run_at) where is_active;

alter table public.schedules enable row level security;

create policy "Owners manage their schedules"
  on public.schedules for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Tick every minute → call the scheduler edge function (applied separately so
-- the function exists first).
-- select cron.schedule('run-due-schedules', '* * * * *', $$
--   select net.http_post(
--     url := 'https://pcyvmpjrszgatwvmyxbg.supabase.co/functions/v1/scheduler',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--                                   'x-cron-secret', (select secret from public.cron_config limit 1)),
--     body := '{}'::jsonb
--   );
-- $$);
