-- Organization name: a workspace setting that displays prominently on the home
-- page so users instantly know which workspace they're using.
--
-- Uses the existing workspace_settings table (migration 0092) — just adds a new
-- key. The home page fetches and displays it alongside the user's greeting.
--
-- Admin-managed (like timezone); absence of a row = no organization name (home
-- page shows just the user's greeting).

-- Seed an empty organization name so the Settings page has something to show.
-- Admins can set it to their actual organization name.
insert into public.workspace_settings (key, value)
values ('organization_name', '')
on conflict (key) do nothing;
