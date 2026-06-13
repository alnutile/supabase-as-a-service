-- Plugins registry: an in-app record of which Edge Function examples this
-- workspace has set up. Source of truth for the Plugins page's "Installed"
-- list. The browser can't introspect actually-deployed functions (that needs a
-- Management API token), so this table is the system-of-record an admin curates
-- as they deploy examples via the CLI / MCP. The catalog of *available* plugins
-- stays static in src/lib/plugins.ts.

create table public.plugins (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,                 -- catalog slug (or a custom one)
  name text not null,
  description text,
  category text,
  source_url text,                           -- link to the example's source
  enabled boolean not null default true,     -- admin toggle; off = set up but paused
  notes text,                                -- free-form: secrets set, provider wired, etc.
  installed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.plugins enable row level security;

-- Authenticated members read; only admins manage (mirrors the tools/guardrails policies).
create policy "Members read plugins"
  on public.plugins for select
  using (auth.uid() is not null);

create policy "Admins insert plugins"
  on public.plugins for insert
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins update plugins"
  on public.plugins for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins delete plugins"
  on public.plugins for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
