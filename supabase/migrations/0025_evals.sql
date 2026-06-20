-- Evals: measure whether the AI pipeline's output is good, and catch regressions
-- when you swap the model or edit prompts.
--
-- A *suite* is a named set of *cases* pointed at a target pipeline. A *case* is an
-- input plus typed *assertions* about the result. A *run* executes every case once
-- (optionally pinned to a model override) and stores a *result* per case, plus a
-- headline score. Phase 1 implements the `rag` target: it scores whether
-- `search_documents` retrieves the right passages (deterministic — no LLM judge).
-- The schema already carries `agent`/`chat` targets and a free-form assertion
-- shape so Phase 2 (rubric-graded report quality) and Phase 3 (model-compare,
-- scheduled drift) slot in without a migration.
--
-- RLS mirrors tools/guardrails: any signed-in member reads; only admins write
-- suites/cases. Runs/results are written by the `evals` edge function
-- (service role); members may read them.

-- A collection of cases against one target pipeline.
create table public.eval_suites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  target_kind text not null default 'rag' check (target_kind in ('rag', 'agent', 'chat')),
  agent_id uuid references public.agents (id) on delete set null,  -- when target_kind = 'agent'
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One test: an input + typed assertions about the result. Assertions are a JSON
-- array like [{"type":"retrieves","doc":"Nightjar"},{"type":"contains","text":"BLUE-OTTER-49"}].
create table public.eval_cases (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.eval_suites (id) on delete cascade,
  name text not null default '',
  input text not null,
  assertions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index eval_cases_suite_idx on public.eval_cases (suite_id);

-- One execution of a suite. `model` is an optional OpenRouter slug override (the
-- model-swap test); null = the profile default. `score` = passed / total.
create table public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.eval_suites (id) on delete cascade,
  model text,
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  total integer not null default 0,
  passed integer not null default 0,
  score double precision,
  cost double precision,
  error text,
  triggered_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index eval_runs_suite_idx on public.eval_runs (suite_id, created_at desc);

-- Per-case outcome within a run. `output` is what the pipeline produced (the
-- retrieved passages for rag); `detail` holds the per-assertion pass/fail.
create table public.eval_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.eval_runs (id) on delete cascade,
  case_id uuid references public.eval_cases (id) on delete set null,
  case_name text not null default '',
  passed boolean not null default false,
  score double precision,
  output text,
  detail jsonb,
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index eval_results_run_idx on public.eval_results (run_id);

alter table public.eval_suites enable row level security;
alter table public.eval_cases enable row level security;
alter table public.eval_runs enable row level security;
alter table public.eval_results enable row level security;

-- Helper-free policies, mirroring guardrails: members read, admins write.
create policy "Members read eval suites" on public.eval_suites for select using (auth.uid() is not null);
create policy "Admins insert eval suites" on public.eval_suites for insert
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
create policy "Admins update eval suites" on public.eval_suites for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
create policy "Admins delete eval suites" on public.eval_suites for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Members read eval cases" on public.eval_cases for select using (auth.uid() is not null);
create policy "Admins insert eval cases" on public.eval_cases for insert
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
create policy "Admins update eval cases" on public.eval_cases for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
create policy "Admins delete eval cases" on public.eval_cases for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Runs/results: members read; only the edge function (service role) writes.
create policy "Members read eval runs" on public.eval_runs for select using (auth.uid() is not null);
create policy "Members read eval results" on public.eval_results for select using (auth.uid() is not null);
