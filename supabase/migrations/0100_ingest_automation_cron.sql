-- 0100_ingest_automation_cron.sql
-- Teach every tenant to self-schedule the PDF-ingest cron tick.
--
-- 0094 made the out-of-band pg_cron jobs (event dispatcher + agent scheduler)
-- tenant-safe: setup_automation_cron() reschedules every job listed by the single
-- source of truth _automation_cron_jobs(), and the deploy pipeline calls it after
-- each `db push`. But the PDF-knowledge `ingest` function (0012) has the SAME
-- shape — a pg_cron job that POSTs to /functions/v1/ingest every minute, gated by
-- the cron_config secret — and it was never added to that list. It used to be
-- scheduled by hand (out of band), so a fresh tenant never got it: uploads enqueue
-- a `documents` row via the enqueue_document trigger, but nothing ever ticks the
-- ingest function, so the doc sits `pending` forever and the file shows
-- "Indexing…" indefinitely. (That's the bug this closes — the exact same class 0094
-- fixed, ingest just got missed.)
--
-- Fix: add ingest to _automation_cron_jobs(). No signature change (same RETURNS
-- TABLE), so a plain create-or-replace is safe. The deploy pipelines
-- (deploy-migrations.yml + release-tenants.yml) already call setup_automation_cron
-- post-migration, so this reschedules the ingest tick on every tenant — new and
-- already-broken — on their next deploy, and automation_cron_status() now reports
-- it too (in-app Automation health banner).

create or replace function public._automation_cron_jobs()
returns table (job_name text, fn text, sched text)
language sql
immutable
as $$
  select * from (values
    ('dispatch-events',   'event-dispatch', '* * * * *'),
    ('run-due-schedules', 'scheduler',      '* * * * *'),
    ('run-ingest',        'ingest',         '* * * * *')
  ) as t(job_name, fn, sched);
$$;

notify pgrst, 'reload schema';
