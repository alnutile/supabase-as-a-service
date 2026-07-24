-- Workspace settings: a tiny admin-managed key/value store for workspace-wide
-- configuration that isn't a feature flag and doesn't warrant its own table.
--
-- First (and for now only) key: `timezone` — the IANA zone the workspace's
-- agentic automations (chat, scheduler, event listeners, webhooks, Slack, loops)
-- should treat as "local" when reasoning about the current date/time, and the
-- default zone for new agent schedules. Without it every unattended run assumes
-- UTC, which reads as the wrong time to a team that lives somewhere else.
--
-- One row per setting keyed by a stable string. ABSENCE of a row = the built-in
-- default (server falls back to 'UTC'), so a fresh workspace behaves exactly as
-- before until an admin sets a zone.
create table if not exists public.workspace_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.workspace_settings enable row level security;

-- Everyone signed in reads settings (the automations run as the service role and
-- read directly, but the app also reads to render the current value); only admins
-- write. Mirrors feature_flags / tools / guardrails. Drop-then-create so a re-run
-- (or a DB where the table pre-exists) is idempotent.
drop policy if exists "Members read workspace settings" on public.workspace_settings;
create policy "Members read workspace settings"
  on public.workspace_settings for select
  using (auth.uid() is not null);

drop policy if exists "Admins write workspace settings" on public.workspace_settings;
create policy "Admins write workspace settings"
  on public.workspace_settings for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Seed the timezone row at UTC so the Settings page always has a value to show
-- (the server still treats a missing/invalid row as UTC, so this is cosmetic).
insert into public.workspace_settings (key, value)
values ('timezone', 'UTC')
on conflict (key) do nothing;

-- Live updates: put workspace_settings in the realtime publication so changing the
-- timezone reflects in every open Settings tab immediately. Idempotent, matching
-- 0054/0058/0061/0065.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'workspace_settings'
  ) then
    alter publication supabase_realtime add table public.workspace_settings;
  end if;
end $$;
