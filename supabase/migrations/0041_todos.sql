-- To-dos — a simple personal/team task list that plugs into the same concepts
-- the rest of the system already uses.
--
-- A `todos` row is just "remember to do this": a title, optional notes, an
-- optional due_date, a `done` flag, and a `position` for manual drag-to-sort
-- ordering (order by position asc, created_at desc — so never-sorted lists fall
-- back to newest-first). Visibility mirrors `collections` / `user_tables`:
-- `private` (owner + admins) or `workspace` (every member can see AND
-- collaborate — check off / edit / reorder), so a shared list works like a
-- shared base.
--
-- `collection_todos` is the many-to-many join that lets a to-do be filed into
-- collections, exactly like `collection_artifacts` does for artifacts — so a
-- collection you chat with can carry tasks alongside its docs. Its RLS inherits
-- the parent collection's visibility (the access logic lives in ONE place, the
-- collections table), identical to collection_artifacts.
--
-- The bottom of this file seeds the `is_builtin` to-do tools (create_todo /
-- list_todos / complete_todo / update_todo / add_todo_to_collection) so the
-- in-app assistant and the chat/scheduler/webhook agent loops can manage tasks,
-- same shape as the authoring builtins in 0040.

-- ---------------------------------------------------------------------------
-- todos
-- ---------------------------------------------------------------------------
create table public.todos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  notes text not null default '',
  due_date date,
  done boolean not null default false,
  completed_at timestamptz,
  position double precision not null default 0,
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index todos_owner_idx on public.todos (owner_id, position asc, created_at desc);
create index todos_due_idx on public.todos (due_date asc) where not done;

alter table public.todos enable row level security;
grant select, insert, update, delete on public.todos to authenticated;

-- Read own or workspace-shared (admins see all) — mirrors user_tables/collections.
create policy "Read own or shared todos"
  on public.todos for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create policy "Insert own todos"
  on public.todos for insert
  with check (owner_id = auth.uid());

-- Workspace = collaborate: members may check off / edit / reorder shared todos.
create policy "Update own or shared todos"
  on public.todos for update
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Deleting is more destructive than editing — owner or admin only.
create policy "Delete own todos"
  on public.todos for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create trigger todos_set_updated_at
  before update on public.todos
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- collection_todos (many-to-many; mirrors collection_artifacts exactly)
-- ---------------------------------------------------------------------------
create table public.collection_todos (
  collection_id uuid not null references public.collections (id) on delete cascade,
  todo_id uuid not null references public.todos (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, todo_id)
);
create index collection_todos_todo_idx on public.collection_todos (todo_id);

alter table public.collection_todos enable row level security;
grant select, insert, delete on public.collection_todos to authenticated;

-- A membership row is visible when its parent collection is visible.
create policy "Read todo memberships of visible collections"
  on public.collection_todos for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

-- Anyone who can collaborate on the collection may file todos into it.
create policy "Add todos to collaborable collections"
  on public.collection_todos for insert
  with check (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

create policy "Remove todos from collaborable collections"
  on public.collection_todos for delete
  using (
    exists (
      select 1 from public.collections c
      where c.id = collection_id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

-- ---------------------------------------------------------------------------
-- Seed the to-do builtins (assistant + all three agent loops). Same insert
-- shape as 0040_authoring_builtins.sql; idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_todo',
  'Create a to-do (a task to remember). Optionally set a due date (YYYY-MM-DD) and file it into a collection (by name; created if missing). Use this to capture tasks from a conversation.',
  '{"type":"object","properties":{"title":{"type":"string"},"notes":{"type":"string","description":"Optional longer notes."},"due_date":{"type":"string","description":"Optional due date, YYYY-MM-DD."},"collection":{"type":"string","description":"Optional collection name (or id) to file this to-do into; created if missing."}},"required":["title"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_todo');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_todos',
  'List to-dos (optionally filter by collection name/id or status: open|done). Shows due dates and done state.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."},"status":{"type":"string","enum":["open","done"],"description":"Filter by status (optional)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_todos');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'complete_todo',
  'Mark a to-do as done (pass its id).',
  '{"type":"object","properties":{"id":{"type":"string","description":"The to-do id."}},"required":["id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'complete_todo');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_todo',
  'Update a to-do: title, notes, due_date (YYYY-MM-DD, or null to clear), or done (true/false).',
  '{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"notes":{"type":"string"},"due_date":{"type":"string","description":"YYYY-MM-DD, or null to clear."},"done":{"type":"boolean"}},"required":["id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_todo');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_todo_to_collection',
  'Add an existing to-do to a collection (both by name or id). The collection is created if it does not exist.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"todo_id":{"type":"string","description":"The to-do id to add."}},"required":["collection","todo_id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_todo_to_collection');
