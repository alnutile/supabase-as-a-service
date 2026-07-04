-- ---------------------------------------------------------------------------
-- 0050 delete_table_row builtin
-- Adds a "delete a row" capability to the Tables feature, completing the row
-- CRUD set (add / query / update / delete). Deliberately narrower than
-- update_table_row: it takes a single row_id (from query_table) rather than a
-- "match" filter, so one call can never bulk-delete — and a missing row is an
-- explicit error, not a silent no-op. This seeds the matching `is_builtin`
-- tool row; the handler lives in supabase/functions/_shared/builtins.ts
-- (runBuiltin) and the MCP server exposes the same tool, both re-enforcing
-- private/workspace access in code (builtins run with the service role).
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'delete_table_row',
  'Delete a single row from a user-created data table. Identify the table by its name (or id) and the row by its "row_id" — query_table returns each row''s id. Deletes exactly one row; errors if the row is not found.',
  '{"type":"object","properties":{"table":{"type":"string","description":"The table name (or id)."},"row_id":{"type":"string","description":"The id of the row to delete (from query_table)."}},"required":["table","row_id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'delete_table_row');
