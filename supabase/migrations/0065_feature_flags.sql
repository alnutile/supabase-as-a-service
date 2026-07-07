-- Feature flags: hide/show sidebar areas workspace-wide.
--
-- This is feature HIDING, not permissions — an admin turns an area off because
-- the company doesn't use it (and doesn't want to confuse staff) or is just
-- trying something out. RLS still protects the underlying data; a hidden link
-- only removes the nav entry (and its page from the ⌘K palette).
--
-- One row per flag keyed by the nav item's stable key (e.g. 'inbox', 'tables').
-- ABSENCE of a row = enabled (the default), so a fresh workspace shows
-- everything; a row with enabled=false hides that area for everyone. Core areas
-- (Home, Chat, Settings) are never flaggable in the UI, so an admin can't lock
-- themselves out of the very page that manages the flags.
create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.feature_flags enable row level security;

-- Everyone signed in reads the flags (the sidebar needs them); only admins
-- write. Mirrors the tools/guardrails admin-write model.
create policy "Members read feature flags"
  on public.feature_flags for select
  using (auth.uid() is not null);

create policy "Admins write feature flags"
  on public.feature_flags for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Live toggles: put feature_flags in the realtime publication so hiding/showing
-- an area updates every open sidebar immediately instead of only on reload.
-- Idempotent, matching 0054/0058/0061.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feature_flags'
  ) then
    alter publication supabase_realtime add table public.feature_flags;
  end if;
end $$;
