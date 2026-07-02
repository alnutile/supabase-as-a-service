-- Seed the `add_table_to_collection` builtin so the assistant (chat bubble,
-- agents, scheduler, webhook) can file a data table into a collection
-- conversationally — completing the set alongside add_to_collection (artifacts)
-- and add_todo_to_collection (to-dos). The executor lives in _shared/builtins.ts.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_table_to_collection',
  'Add an existing data table to a collection (both by name or id). The collection is created if it does not exist.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"table":{"type":"string","description":"The table name or id to add."}},"required":["collection","table"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_table_to_collection');
