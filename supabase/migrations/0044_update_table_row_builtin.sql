-- ---------------------------------------------------------------------------
-- 0044 update_table_row builtin
-- Adds an "update a row" capability to the Tables feature. Until now the
-- assistant/agents could create tables, add rows, and query them, but not
-- modify existing rows — so a chat that was asked to change a value had to
-- report it couldn't. This seeds the matching `is_builtin` tool row; the
-- handler lives in supabase/functions/_shared/builtins.ts (runBuiltin) and the
-- MCP server exposes the same tool, both re-enforcing private/workspace access
-- in code (builtins run with the service role).
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_table_row',
  'Update existing row(s) in a user-created data table. Identify the table by its name, pass a "match" object of column=value equality filters selecting which row(s) to change (e.g. {"id": 3}), and a "values" object with the columns to set. A match is required so you never rewrite the whole table.',
  '{"type":"object","properties":{"table":{"type":"string","description":"The table name (or id)."},"match":{"type":"object","description":"Column=value equality filters identifying which row(s) to update (required)."},"values":{"type":"object","description":"Column key/value pairs to set on the matched row(s)."}},"required":["table","match","values"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_table_row');
