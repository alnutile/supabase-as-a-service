-- To-do lifecycle: a real status lane + provenance.
--
-- Until now a to-do was binary: `done` or not. That is enough for a checklist
-- and not enough for a queue you actually work — "committed to but not started"
-- and "waiting on someone else" both read as open, so the list is a flat wall
-- of items with no way to see what is moving and what is stuck.
--
-- `status` adds the lane (triage → next → doing → blocked → done). `done` STAYS
-- the source of truth for "closed": every existing surface reads it (the REST
-- API, the `is_builtin` to-do tools, the Home dashboard tiles, the collections
-- context block the assistant is given, the `todos_due_idx` partial index), and
-- none of them need to learn about lanes to keep working. A trigger keeps the
-- pair consistent no matter which half a writer touches, so an old client that
-- only knows `done` can never leave a row in a contradictory state.
--
-- `source` records who filed the to-do — an agent loop, the inbox, the REST
-- API — so the Focus view can lead with "unreviewed work the AI put on your
-- plate" instead of treating it like something you wrote down yourself.

alter table public.todos
  add column if not exists status text not null default 'triage'
    check (status in ('triage', 'next', 'doing', 'blocked', 'done')),
  add column if not exists source text;

comment on column public.todos.status is
  'Lifecycle lane: triage|next|doing|blocked|done. Kept consistent with `done` by todos_sync_status().';
comment on column public.todos.source is
  'Provenance: agent|inbox|api|null (added by hand in the UI).';

-- Existing rows: a closed to-do is 'done', an open one starts in 'triage'.
update public.todos set status = 'done' where done and status <> 'done';

-- Board lanes are read per owner, newest first — same shape as todos_owner_idx.
create index if not exists todos_status_idx on public.todos (owner_id, status, position asc);

-- ---------------------------------------------------------------------------
-- done <-> status reconciliation
--
-- Mirrors reconcileStatus() in src/lib/todos.ts, which the UI applies
-- optimistically; keeping the rule in the database means an API/tool caller
-- that sets only one half gets the same result as the UI.
--   • status set to 'done'      → done = true, completed_at stamped
--   • status moved off 'done'   → done = false, completed_at cleared
--   • done set true             → status = 'done'
--   • done set false            → status = 'next' (un-ticking is a correction,
--                                 not a re-triage)
-- When BOTH change in one statement the explicit `status` wins, so a writer
-- that knows about lanes is never overridden by the boolean.
-- ---------------------------------------------------------------------------
create or replace function public.todos_sync_status()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- A BEFORE INSERT trigger cannot tell "column omitted" from "column set to
    -- its default", so an insert that carries only `done` (every pre-0116
    -- writer) would otherwise be overruled by the 'triage' default. Let the
    -- boolean win in exactly that case; a caller that names a lane keeps it.
    if new.done and new.status = 'triage' then
      new.status := 'done';
    else
      new.done := new.status = 'done';
    end if;
  elsif new.status is distinct from old.status then
    new.done := new.status = 'done';
  elsif new.done is distinct from old.done then
    new.status := case when new.done then 'done' else 'next' end;
  end if;

  if new.done then
    if new.completed_at is null then new.completed_at := now(); end if;
  else
    new.completed_at := null;
  end if;

  return new;
end;
$$;

revoke execute on function public.todos_sync_status() from anon, authenticated;

drop trigger if exists todos_sync_status on public.todos;
create trigger todos_sync_status
  before insert or update on public.todos
  for each row execute function public.todos_sync_status();

-- ---------------------------------------------------------------------------
-- Teach the to-do builtins about the new fields. The tool rows are data, so an
-- existing workspace picks the richer schema up on migration rather than on a
-- redeploy. `status` on list_todos keeps its open|done meaning AND accepts a
-- lane name — 'done' means the same thing under both readings.
-- ---------------------------------------------------------------------------
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
    'collection', jsonb_build_object('type', 'string', 'description', 'Optional collection name or id to file it into (created if missing).')
  ),
  'required', jsonb_build_array('title')
)
where name = 'create_todo' and is_builtin;

update public.tools
set input_schema = jsonb_build_object(
  'type', 'object',
  'properties', jsonb_build_object(
    'status', jsonb_build_object(
      'type', 'string',
      'description', 'Filter: open, done, or one lane (triage|next|doing|blocked).'
    ),
    'collection', jsonb_build_object('type', 'string', 'description', 'Only to-dos in this collection (name or id).')
  )
)
where name = 'list_todos' and is_builtin;

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
    'done', jsonb_build_object('type', 'boolean')
  ),
  'required', jsonb_build_array('id')
)
where name = 'update_todo' and is_builtin;
