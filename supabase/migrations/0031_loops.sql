-- Loops — goal-directed agent runs that self-correct on measured feedback and
-- stop at a price cap.
--
-- A *loop* layers a goal + stopping criteria on top of an existing agent. The
-- `loop` edge function drives a closed feedback cycle (after the COMPILOT
-- pattern): the agent proposes a candidate → a feedback source scores it 0–100
-- → the score feeds the next iteration → repeat, keeping the best-scoring
-- result. The run stops when ANY criterion fires:
--   1. budget         — cumulative model cost ≥ budget_usd (a hard per-run cap)
--   2. max_iterations — iteration cap reached
--   3. converged      — the agent calls the `loop_done` tool
--   4. target_reached — best score ≥ target_score (optional)
--
-- Feedback source: an `http` tool (loops.feedback_tool_id) returning {score,
-- detail}, OR — when none is set — a built-in utility-model judge graded against
-- loops.rubric. The price cap uses the REAL per-call cost OpenRouter returns
-- (usage_events.cost), so it's a true dollar ceiling, not a token estimate.
--
-- RLS mirrors agents: any signed-in member reads; the owner (or an admin) writes.
-- loop_runs are written only by the edge function (service role); members read.

-- A loop config.
create table public.loops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  goal text not null default '',                                   -- the objective, injected into context init
  agent_id uuid not null references public.agents (id) on delete cascade,
  feedback_tool_id uuid references public.tools (id) on delete set null,  -- http tool → {score, detail}; null = judge
  rubric text not null default '',                                 -- judge grading rubric (used when no feedback tool)
  max_iterations integer not null default 10 check (max_iterations between 1 and 50),
  budget_usd numeric(10,4) not null default 1.0 check (budget_usd > 0),    -- hard per-run cost cap
  target_score numeric check (target_score is null or (target_score >= 0 and target_score <= 100)),
  visibility visibility not null default 'private',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index loops_owner_idx on public.loops (owner_id);

-- One execution of a loop. The audit + live-progress record.
create table public.loop_runs (
  id uuid primary key default gen_random_uuid(),
  loop_id uuid not null references public.loops (id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  stop_reason text check (stop_reason in ('budget', 'max_iterations', 'converged', 'target_reached', 'error')),
  iterations integer not null default 0,
  cost_spent numeric(10,4) not null default 0,                    -- running sum of model cost
  best_score numeric,                                             -- 0–100
  best_output text,                                               -- the best candidate seen
  transcript jsonb not null default '[]'::jsonb,                  -- [{iteration, score, detail, cost_spent, preview}]
  error text,
  triggered_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index loop_runs_loop_idx on public.loop_runs (loop_id, started_at desc);

alter table public.loops enable row level security;
alter table public.loop_runs enable row level security;

-- Loops are a shared workspace catalogue like agents: everyone signed in reads;
-- the owner (or an admin) edits. (Visibility is reserved for a future
-- owner-private mode; reads are member-wide today, matching agents.)
create policy "Members read loops"
  on public.loops for select
  using (auth.uid() is not null);

create policy "Owner creates loops"
  on public.loops for insert
  with check (owner_id = auth.uid());

create policy "Owner or admin updates loops"
  on public.loops for update
  using (owner_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (owner_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Owner or admin deletes loops"
  on public.loops for delete
  using (owner_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Runs: members read; only the edge function (service role) writes.
create policy "Members read loop runs"
  on public.loop_runs for select
  using (auth.uid() is not null);

-- Live progress: the UI subscribes to loop_runs while a loop is running.
alter publication supabase_realtime add table public.loop_runs;

-- Log loop creation into the activity feed (mirrors log_agent).
create or replace function public.log_loop()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_log (type, summary, detail, actor_id)
  values ('loop.created', 'Loop created: ' || new.name,
          jsonb_build_object('loop_id', new.id), new.owner_id);
  return new;
end; $$;
revoke execute on function public.log_loop() from anon, authenticated, public;

create trigger trg_log_loop
  after insert on public.loops
  for each row execute function public.log_loop();
