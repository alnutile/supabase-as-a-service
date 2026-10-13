-- 0130_list_todos_notes.sql
--
-- list_todos now returns each to-do's notes (indented under its title, clipped
-- at 2000 chars each) — before, it selected only the title, so an agent or an
-- external Claude could never read the detail a person wrote on a to-do.
-- Rendering is the pure, unit-tested formatTodoList in _shared/todos.ts.
-- Schema-less: this only re-describes the tool.

update public.tools
set description = 'List to-dos, optionally filtered by collection or status. Shows each one''s title, lane, due date, provenance, whether the team can see it, its id, and its notes (indented under it; long notes are clipped at 2000 chars).'
where name = 'list_todos' and is_builtin;
