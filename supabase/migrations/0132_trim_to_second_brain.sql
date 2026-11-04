-- 0132_trim_to_second_brain.sql
-- Trim the workspace down toward a local-first "second brain".
--
-- Removed from the app and edge functions: Inbox (email / Slack / message
-- ingest), the Knowledge compiler, Agents + agent jobs, Listeners/Events,
-- Loops, custom Tools + Forge, Webhooks, the REST API (artifacts / todos /
-- run-tool), Feedback, the Features board, Dropbox and invites.
--
-- This migration is deliberately NON-DESTRUCTIVE: no tables are dropped, so the
-- data stays put and the change can be reverted. It only stops the background
-- machinery that would otherwise keep calling functions that no longer exist,
-- and hides the builtins whose implementations were removed.

-- 1. Only the PDF ingest tick remains. setup_automation_cron() reads this list,
--    so the deploy pipeline stops rescheduling the removed jobs.
create or replace function public._automation_cron_jobs()
returns table (job_name text, fn text, sched text)
language sql
immutable
as $$
  select * from (values
    ('run-ingest', 'ingest', '* * * * *')
  ) as t(job_name, fn, sched);
$$;

-- 2. Unschedule the jobs that pointed at deleted functions (scheduler,
--    event-dispatch, email-poll). Guarded so it is a no-op without pg_cron.
do $$
declare
  v_job text;
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    foreach v_job in array array['dispatch-events', 'run-due-schedules', 'run-email-poll'] loop
      if exists (select 1 from cron.job where jobname = v_job) then
        perform cron.unschedule(v_job);
      end if;
    end loop;
  end if;
end;
$$;

-- 3. Deactivate builtins whose implementations were removed, so chat and MCP
--    stop offering them to the model. Custom http tools are left as they are
--    (existing rows keep working; there is just no UI to make new ones).
update public.tools
set is_active = false
where kind = 'builtin'
  and name in (
    'send_email',
    'send_slack_message',
    'check_email',
    'start_loop',
    'check_loop',
    'list_loops',
    'save_message',
    'list_messages',
    'add_message_to_collection',
    'create_agent_job',
    'get_agent_job',
    'list_agent_jobs',
    'cancel_agent_job',
    'list_agents',
    'create_agent',
    'update_agent',
    'list_tools',
    'create_http_tool',
    'create_webhook',
    'compile_collection',
    'list_knowledge_pages',
    'get_knowledge_page',
    'update_knowledge_page',
    'list_conflicts',
    'resolve_conflict',
    'get_change_brief',
    'set_compile_policy'
  );

notify pgrst, 'reload schema';
