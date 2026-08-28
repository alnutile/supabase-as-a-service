-- 0112_update_agent_builtin.sql
-- ---------------------------------------------------------------------------
-- Add update_agent builtin tool so chat and AI can update existing agents.
--
-- This closes the gap where create_agent and list_agents exist but there's
-- no way to modify an agent's fields (name, description, instructions,
-- tool_ids, collection_ids, is_active) from chat or the agent loops.
-- The handler enforces owner-or-admin access in code (same as the RLS policy).
-- ---------------------------------------------------------------------------

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_agent',
  'Update an existing agent (by id or exact name). Change its name, description, instructions (system prompt), tool_ids, collection_ids, or is_active status. Owner or admin only.',
  '{"type":"object","properties":{"agent":{"type":"string","description":"The agent id or exact name."},"name":{"type":"string","description":"New name for the agent."},"description":{"type":"string","description":"New description."},"instructions":{"type":"string","description":"New system prompt."},"tool_ids":{"type":"array","items":{"type":"string"},"description":"New list of tool ids the agent may use."},"collection_ids":{"type":"array","items":{"type":"string"},"description":"New list of collection ids the agent uses as context."},"is_active":{"type":"boolean","description":"Activate or deactivate the agent."}},"required":["agent"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_agent');
