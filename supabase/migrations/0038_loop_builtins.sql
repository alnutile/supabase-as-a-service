-- Loop builtins — expose the looping system (the COMPILOT-style goal-directed
-- runs driven by the `loop` edge function) to the in-app assistant, alongside the
-- MCP server's create_loop/run_loop/get_loop_run. These are ordinary `is_builtin`
-- `tools` rows dispatched by _shared/builtins.ts (runBuiltin), so all three agent
-- loops (chat, scheduler, webhook) get them and the usual gates apply — admin can
-- toggle them on ToolsPage, an agent's tool_ids scope them, and the
-- webhooks.allow_tools lock still holds. `start_loop` spends model budget (capped
-- per run by the loop's budget_usd), so it's exfiltration-adjacent like send_email:
-- an admin can deactivate it if they don't want the assistant kicking off runs.

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'start_loop',
  'Start a goal-directed loop: give it a goal (the prompt) and a rubric (how to grade candidates 0–100). It iterates in the background — propose a candidate, score it, keep the best — stopping when it hits its budget, iteration cap, target score, or converges. Returns a run id to check with check_loop.',
  '{"type":"object","properties":{"goal":{"type":"string","description":"The objective the loop optimizes toward (the prompt)."},"rubric":{"type":"string","description":"How to grade each candidate 0-100 (used by the built-in judge when no feedback tool is set)."},"name":{"type":"string","description":"Optional label; defaults to the goal."},"max_iterations":{"type":"integer","description":"Max rounds, 1-50 (default 10)."},"budget_usd":{"type":"number","description":"Hard model-cost cap in USD for the whole run (default 1)."},"target_score":{"type":"number","description":"Stop early once the best score reaches this (0-100, optional)."},"agent":{"type":"string","description":"Optional agent name/id to run; a default loop agent is used if omitted."},"feedback_tool":{"type":"string","description":"Optional http tool name/id that scores candidates ({score, detail})."}},"required":["goal"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'start_loop');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'check_loop',
  'Check in on a loop run: its status, iterations, cost so far, best score, and (once done) the best output. Pass the run_id from start_loop, or a loop name/id to get its latest run.',
  '{"type":"object","properties":{"run_id":{"type":"string","description":"The run id returned by start_loop."},"loop":{"type":"string","description":"Or a loop name/id to check its latest run."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'check_loop');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_loops',
  'List the goal-directed loops you can run (name, goal, budget, iteration cap).',
  '{"type":"object","properties":{}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_loops');
