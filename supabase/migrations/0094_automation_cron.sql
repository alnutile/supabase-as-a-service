-- 0094_automation_cron.sql
-- Make out-of-band cron scheduling automatic + tenant-safe.
--
-- The agent scheduler (0010) and the event dispatcher (0063) each need a pg_cron
-- job that POSTs to their edge function every minute. The command embeds the
-- project's OWN URL (https://<ref>.supabase.co/...), which a shared migration
-- can't hardcode across tenants — so historically each job was scheduled by hand
-- after deploy. A fresh tenant silently had no dispatcher: events emitted, never
-- processed, listeners never ran. (That's the bug this closes.)
--
-- This ships the *logic* tenant-agnostically:
--   * setup_automation_cron(base_url) idempotently (re)schedules every required
--     job. It reads the cron secret via a subquery INSIDE the command string, so
--     the secret is resolved at tick-time and never baked into cron.job.command.
--   * automation_cron_status() reports which expected jobs are actually scheduled
--     (drives the in-app "Automation health" check).
--
-- The deploy pipeline calls setup_automation_cron post-migration with the
-- project's own URL (CI already knows the ref); an admin can also call it from
-- the app. Both are gated: the superuser/service caller (auth.uid() null) is
-- allowed; an authenticated caller must be an admin. anon/public cannot execute
-- it at all (revoked below), so base_url — which controls where the cron POSTs
-- the secret — is never attacker-controllable.

-- The single source of truth for which jobs must exist and where they point.
-- Add a row here to teach every tenant a new cron via normal CD.
create or replace function public._automation_cron_jobs()
returns table (job_name text, fn text, sched text)
language sql
immutable
as $$
  select * from (values
    ('dispatch-events',   'event-dispatch', '* * * * *'),
    ('run-due-schedules', 'scheduler',      '* * * * *')
  ) as t(job_name, fn, sched);
$$;

create or replace function public.setup_automation_cron(p_base_url text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := rtrim(coalesce(p_base_url, ''), '/');
  v_jobs jsonb := '[]'::jsonb;
  v_url text;
  v_spec record;
begin
  -- Authorize: superuser/service (CI, auth.uid() null) OR an app admin.
  if auth.uid() is not null and not public._is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;
  if v_base = '' then
    raise exception 'base_url is required';
  end if;

  for v_spec in select * from public._automation_cron_jobs() loop
    v_url := v_base || '/functions/v1/' || v_spec.fn;
    -- Idempotent: drop any existing job of the same name, then (re)create it.
    if exists (select 1 from cron.job where jobname = v_spec.job_name) then
      perform cron.unschedule(v_spec.job_name);
    end if;
    perform cron.schedule(v_spec.job_name, v_spec.sched, format($cmd$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select secret from public.cron_config limit 1)
        ),
        body := '{}'::jsonb
      );
    $cmd$, v_url));
    v_jobs := v_jobs || jsonb_build_object('name', v_spec.job_name, 'url', v_url, 'schedule', v_spec.sched);
  end loop;

  return jsonb_build_object('scheduled', v_jobs);
end;
$$;
revoke execute on function public.setup_automation_cron(text) from anon, public;
grant execute on function public.setup_automation_cron(text) to authenticated, service_role;

create or replace function public.automation_cron_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := '[]'::jsonb;
  v_spec record;
begin
  if auth.uid() is not null and not public._is_admin(auth.uid()) then
    raise exception 'Not authorized';
  end if;
  for v_spec in select * from public._automation_cron_jobs() loop
    v := v || jsonb_build_object(
      'name', v_spec.job_name,
      'scheduled', exists (select 1 from cron.job where jobname = v_spec.job_name and active)
    );
  end loop;
  return v;
end;
$$;
revoke execute on function public.automation_cron_status() from anon, public;
grant execute on function public.automation_cron_status() to authenticated, service_role;

-- Expose the new RPCs to PostgREST immediately, so the post-migration CI step
-- (and the app) can call them without waiting for the next schema-cache refresh.
notify pgrst, 'reload schema';
