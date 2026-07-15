-- Shared-tier per-customer provisioning seed — run ONCE per shared-tier
-- customer, against THAT customer's database, at onboarding.
--
-- This is deliberately NOT a file under supabase/migrations/. Everything there
-- applies to the WHOLE fleet (including the host/canary), so a migration that
-- seeded this flag would hide the Features board for everyone. This seed is a
-- per-customer step instead.
--
-- What it does: hides the "Features" board (self-improvement kanban) from the
-- sidebar + Cmd-K palette for a shared-tier customer, who extends via data +
-- Forge rather than repo source changes. `features` is a normal (non-alwaysOn)
-- nav key, so feature_flags {key:'features', enabled:false} hides it live via
-- Layout's realtime subscription — no rebuild.
--
-- Note: this is feature HIDING, not permissions. The /features route stays
-- registered and the `features` table RLS still lets members read/insert, so a
-- user who knows the URL can still reach it. Hardening that is a separate
-- change (route guard / RLS) — see docs/multi-tenant-hosting.md.
--
-- Run it with either:
--   psql "$DATABASE_URL" -f scripts/seed-shared-tier.sql
--   supabase db execute --file scripts/seed-shared-tier.sql   (after `supabase link`)
--
-- `do update` forces the flag off even if an admin re-enabled it (shared-tier
-- policy). Switch to `do nothing` if you'd rather respect a later admin toggle.

insert into public.feature_flags (key, enabled)
values ('features', false)
on conflict (key) do update set enabled = excluded.enabled;
