-- Model Profiles: name the job, not the model.
--
-- A profile is a named job slot the workspace assigns a model to. Features bind
-- to a profile `key` (e.g. 'orchestrator', 'utility'); admins re-point the key
-- to a different model in Settings → Models. No feature references a model id
-- directly. The DB row is the source of truth; the ANTHROPIC_MODEL env var is
-- only a fallback when the row can't be loaded. `provider` is locked to
-- 'anthropic' for now — the seam for later, not a feature today.

create table public.model_profiles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,                                    -- machine name features bind to
  name text not null,                                          -- display name
  description text not null default '',                        -- what this profile powers (shown in UI)
  provider text not null default 'anthropic' check (provider in ('anthropic')),
  model text not null,                                         -- e.g. 'claude-opus-4-8'
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.model_profiles enable row level security;

-- Any signed-in member can read the profiles; only admins manage them
-- (mirrors the tools table's admin policies). Built-in rows are not deletable.
create policy "Members read model profiles"
  on public.model_profiles for select
  using (auth.uid() is not null);

create policy "Admins insert model profiles"
  on public.model_profiles for insert
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins update model profiles"
  on public.model_profiles for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins delete non-builtin model profiles"
  on public.model_profiles for delete
  using (
    is_builtin = false
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Two seeded built-in profiles.
insert into public.model_profiles (key, name, description, model, is_builtin) values
  ('orchestrator', 'Orchestrator', 'Powers chat, agents, webhooks and scheduled runs', 'claude-opus-4-8', true),
  ('utility', 'Utility', 'Cheap + fast model for guardrails and routine background work.', 'claude-haiku-4-5-20251001', true);
