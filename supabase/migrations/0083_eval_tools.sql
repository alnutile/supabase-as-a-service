-- Tool-usage evals: test whether the assistant CALLS the right tools (not just
-- what it says), plus a deterministic `tool` target that exercises a tool in
-- isolation. No new tables — this rides the existing eval_cases.assertions shape.
--
-- Two additions:
--  1. `sandbox_tools` — when true (default), a chat/agent eval run executes only
--     READ-ONLY tools; side-effecting/external tools (create_*, send_email, http,
--     MCP, get_secret, …) are CAPTURED but not executed. So a suite can assert
--     "it called create_todo with the right title" and be re-run across a model
--     matrix on a schedule without ever mutating the workspace or firing external
--     actions. Turn it off for an opt-in integration test that verifies real
--     side-effects (via the Activity/Events feeds).
--  2. `tool` target — a case's input is JSON {"tool","input"}; the runner dispatches
--     the tool directly (no model, like the `rag` target) and assertions grade the
--     result text. Tests "does this tool return the right output for this input".

alter table public.eval_suites
  add column if not exists sandbox_tools boolean not null default true;

alter table public.eval_suites
  drop constraint if exists eval_suites_target_kind_check;
alter table public.eval_suites
  add constraint eval_suites_target_kind_check
  check (target_kind in ('rag', 'agent', 'chat', 'tool'));

comment on column public.eval_suites.sandbox_tools is
  'When true (default), chat/agent eval runs execute only read-only tools; side-effecting/external tools are captured but NOT executed, so repeatable runs never mutate the workspace or fire external actions.';
