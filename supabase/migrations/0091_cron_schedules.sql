-- Cron-expression scheduling for agents.
--
-- Until now a `schedules` row could only repeat on a fixed `interval_minutes`
-- (every N minutes). That can't express "the 15th of every month" or "the last
-- day of the month at 9am". This adds an optional standard 5-field cron
-- expression + a timezone; when `cron_expr` is set it OWNS the cadence and the
-- scheduler computes `next_run_at` from it (in `timezone`) instead of
-- `now + interval_minutes`. `interval_minutes` stays for back-compat: existing
-- rows (and the preset dropdown) keep working untouched, cron is purely additive.
--
-- The pg_cron tick is still every minute, so cron resolution is 1-minute floored
-- (sub-minute fields can't fire more often than the tick) — same as the old
-- interval path.

alter table public.schedules
  add column if not exists cron_expr text,
  add column if not exists timezone text not null default 'UTC';

comment on column public.schedules.cron_expr is
  'Optional standard 5-field cron expression (min hour day-of-month month day-of-week). When set, it OWNS the cadence: the scheduler computes next_run_at from it in `timezone`, ignoring interval_minutes. Supports croner extensions like L (last day of month).';
comment on column public.schedules.timezone is
  'IANA timezone (e.g. America/New_York) the cron_expr is evaluated in. Ignored for interval-only schedules. Defaults to UTC.';
