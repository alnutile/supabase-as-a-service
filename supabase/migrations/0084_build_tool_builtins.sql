-- 0084_build_tool_builtins.sql
-- ---------------------------------------------------------------------------
-- Close the "the internal assistant can't build agents" gap.
--
-- The MCP server (supabase/functions/mcp/index.ts) has always exposed the
-- "build" tools — create_agent / list_agents / create_http_tool / list_tools /
-- create_webhook and the skill CRUD (create_skill / list_skills / get_skill /
-- update_skill / delete_skill) — so an EXTERNAL Claude could push agents, tools,
-- webhooks, and prompts into the workspace. But those handlers lived only in the
-- MCP server: there was no `is_builtin` tools row and no runBuiltin case, so the
-- in-app chat (and the scheduler / webhook / Slack agent loops) were never handed
-- them and could not create or manage agents — even though that is a headline
-- feature by design.
--
-- The handlers now live in _shared/builtins.ts (runBuiltin), the MCP server
-- delegates to them, and this migration seeds them as `is_builtin` tools so the
-- internal loops load and offer them. They mirror the input schemas the MCP
-- server already declares. Seeded active (per-tool gates stay: create_http_tool
-- and always-on prompts re-check admin in code, since the loops run as the
-- service role). Idempotent via `where not exists`.
-- ---------------------------------------------------------------------------

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_agents',
  'List the agents defined on this workspace (name, id, active state, description).',
  '{"type":"object","properties":{}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_agents');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_agent',
  'Create a new agent: a deployable unit with a name, a system prompt (instructions), optional tool ids it may use, and optional collection ids it uses as context. Appears in the dashboard under Agents.',
  '{"type":"object","properties":{"name":{"type":"string"},"instructions":{"type":"string","description":"The agent system prompt."},"description":{"type":"string"},"tool_ids":{"type":"array","items":{"type":"string"},"description":"Tool ids the agent may use."},"collection_ids":{"type":"array","items":{"type":"string"},"description":"Collection ids the agent uses as context."}},"required":["name","instructions"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_agent');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_tools',
  'List the tools (capabilities) available on this workspace.',
  '{"type":"object","properties":{}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_tools');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_http_tool',
  'Create a custom HTTP tool the assistant can call. Claude posts the inputs as JSON to the given URL. For authenticated APIs, set headers and reference a workspace Vault secret with {{vault:secret_name}} — it is resolved server-side at call time, so the credential never appears in the tool row or the conversation. Admin only.',
  '{"type":"object","properties":{"name":{"type":"string","description":"snake_case function name"},"description":{"type":"string","description":"When to use it."},"url":{"type":"string","description":"Endpoint that receives the inputs."},"input_schema":{"type":"object","description":"JSON Schema for the arguments."},"method":{"type":"string","enum":["POST","GET"]},"headers":{"type":"object","description":"Headers sent with every call, e.g. {\"Authorization\": \"Bearer {{vault:my_api_key}}\"}. {{vault:name}} placeholders are replaced with workspace Vault secrets at call time."}},"required":["name","description","url"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_http_tool');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_webhook',
  'Create a webhook (a public URL that runs a prompt on inbound payloads). Returns the URL.',
  '{"type":"object","properties":{"name":{"type":"string"},"prompt":{"type":"string","description":"What to do with each payload."}},"required":["name"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_webhook');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_skill',
  'Create a saved prompt/skill. Set always_on to apply it to every chat (an always-on system prompt — admin only); otherwise it is a personal on-demand skill invoked with "/".',
  '{"type":"object","properties":{"name":{"type":"string"},"instructions":{"type":"string"},"description":{"type":"string"},"always_on":{"type":"boolean"},"output_mode":{"type":"string","enum":["artifact","reply"],"description":"artifact = emit an artifact; reply = answer inline (default artifact)."}},"required":["name","instructions"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_skill');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_skills',
  'List skills and always-on prompts you can see (your own on-demand skills + every always-on prompt). Each row shows its id, name, mode (always-on prompt vs on-demand skill), and whether it is built-in. Filter with always_on and/or a text query.',
  '{"type":"object","properties":{"always_on":{"type":"boolean","description":"true = only always-on prompts; false = only on-demand skills; omit = both."},"query":{"type":"string","description":"Optional case-insensitive substring of the name/description."},"limit":{"type":"number","description":"Max rows (default 50, max 200)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_skills');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'get_skill',
  'Read one skill or always-on prompt by id or exact name: returns its id, name, mode, output_mode, description, and full instructions (the prompt body). Use before update_skill to see the current text.',
  '{"type":"object","properties":{"skill":{"type":"string","description":"The skill/prompt id or its exact name."}},"required":["skill"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'get_skill');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_skill',
  'Edit an existing skill or always-on prompt in place (by id or exact name) — change its name, description, instructions (the prompt body), output_mode, or always_on flag. Personal on-demand skills are editable by their owner; always-on prompts (and toggling a skill to always-on) require admin.',
  '{"type":"object","properties":{"skill":{"type":"string","description":"The skill/prompt id or its exact name."},"name":{"type":"string"},"description":{"type":"string"},"instructions":{"type":"string","description":"The new prompt body."},"output_mode":{"type":"string","enum":["artifact","reply"]},"always_on":{"type":"boolean","description":"Turn always-on on/off (admin only)."}},"required":["skill"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_skill');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'delete_skill',
  'Delete a skill or always-on prompt (by id or exact name). Personal skills are deletable by their owner; always-on prompts require admin. Built-in prompts cannot be deleted.',
  '{"type":"object","properties":{"skill":{"type":"string","description":"The skill/prompt id or its exact name."}},"required":["skill"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'delete_skill');
