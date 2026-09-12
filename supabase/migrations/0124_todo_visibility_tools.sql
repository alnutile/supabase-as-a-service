-- To-do visibility over the tool surface.
--
-- Numbering note: 0124 is the next free prefix on main, and `migrations.test.ts`
-- requires prefixes to be both unique AND gap-free — so this is the only number
-- this file can carry today. The open PR #361 also claims 0124
-- (`0124_repositories.sql`); whichever of the two merges second renumbers to
-- 0125, since a duplicate prefix aborts `db push` and nothing after it applies
-- (the 0065 / 0078 / 0086 / 0109 collisions). Skipping ahead to 0125 now is not
-- an option: it would open a gap at 0124 and fail the same guard.
--
-- `todos.visibility` (private|workspace) has existed since migration 0041 and
-- the REST `todos` function has always accepted it, but the `create_todo` /
-- `update_todo` builtins hardcoded `private` — so every to-do an agent, the
-- MCP server, the CLI or a `run-tool` call created was owner-only with no way
-- to share it, and no way to promote one afterwards either. Migration 0122
-- covers the collection case (filing into a workspace collection promotes the
-- item), but an ad-hoc "add this as a team task" had nowhere to land.
--
-- No schema change: this only re-seeds the two tool schemas so the model knows
-- the argument exists. The handlers in `_shared/builtins.ts` do the work, and
-- the MCP server delegates to them, so both paths behave identically.
-- `update_todo` is owner-gated in code: every member can re-lane or complete a
-- workspace to-do, but only its owner changes who can see it.

update public.tools
set input_schema = jsonb_build_object(
  'type', 'object',
  'properties', jsonb_build_object(
    'title', jsonb_build_object('type', 'string', 'description', 'What needs doing.'),
    'notes', jsonb_build_object('type', 'string', 'description', 'Optional detail.'),
    'due_date', jsonb_build_object('type', 'string', 'description', 'Optional due date, YYYY-MM-DD.'),
    'status', jsonb_build_object(
      'type', 'string',
      'enum', jsonb_build_array('triage', 'next', 'doing', 'blocked', 'done'),
      'description', 'Lifecycle lane. Defaults to triage so a person reviews what you filed.'
    ),
    'visibility', jsonb_build_object(
      'type', 'string',
      'enum', jsonb_build_array('private', 'workspace'),
      'description', 'Who can see it: private (owner + admins, the default) or workspace — the whole team can see it, tick it off and reorder it. Use workspace whenever the user means a team or shared task.'
    ),
    'collection', jsonb_build_object('type', 'string', 'description', 'Optional collection name or id to file it into (created if missing). A workspace collection promotes the to-do to workspace on its own.')
  ),
  'required', jsonb_build_array('title')
)
where name = 'create_todo' and is_builtin;

update public.tools
set input_schema = jsonb_build_object(
  'type', 'object',
  'properties', jsonb_build_object(
    'id', jsonb_build_object('type', 'string', 'description', 'The to-do id.'),
    'title', jsonb_build_object('type', 'string'),
    'notes', jsonb_build_object('type', 'string'),
    'due_date', jsonb_build_object('type', 'string', 'description', 'YYYY-MM-DD, or null to clear.'),
    'status', jsonb_build_object(
      'type', 'string',
      'enum', jsonb_build_array('triage', 'next', 'doing', 'blocked', 'done'),
      'description', 'Move it to a lane. Setting done is equivalent to status=done.'
    ),
    'done', jsonb_build_object('type', 'boolean'),
    'visibility', jsonb_build_object(
      'type', 'string',
      'enum', jsonb_build_array('private', 'workspace'),
      'description', 'Who can see it: workspace shares it with the whole team, private pulls it back to the owner. Owner-only.'
    )
  ),
  'required', jsonb_build_array('id')
)
where name = 'update_todo' and is_builtin;

update public.tools
set description = 'List to-dos, optionally filtered by collection or status. Shows each one''s lane, due date, provenance, whether the team can see it, and its id.'
where name = 'list_todos' and is_builtin;
