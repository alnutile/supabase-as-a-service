-- Per-user memory — a place for the assistant to remember durable facts about
-- each user so it can serve them better across conversations (issue #145).
--
-- A `user_memories` row is one remembered fact ("prefers concise answers",
-- "works on the marketing team", "timezone is CET"). Unlike todos/links/
-- collections (which are private-OR-workspace), memory is deliberately
-- OWNER-ONLY — it's personal context about a single person, same trust model as
-- `conversations`/`messages`. No workspace-shared mode and no collections join:
-- a memory isn't content to file, it's context the AI carries.
--
-- An optional `key` is a short stable label ("timezone", "tone-preference") the
-- assistant can use to overwrite a fact instead of piling up duplicates; a
-- partial unique index enforces one row per (owner, key) when a key is set.
--
-- The chat function injects the caller's memories into the system prompt (via
-- `formatMemoriesForPrompt` in _shared/memory.ts) so they actually shape
-- replies; the bottom of this file seeds the `is_builtin` memory tools
-- (remember / list_memories / update_memory / forget) so the assistant and all
-- three agent loops (chat, scheduler, webhook) can manage them — same seed
-- shape as 0041_todos.sql.

-- ---------------------------------------------------------------------------
-- user_memories
-- ---------------------------------------------------------------------------
create table public.user_memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per (owner, key) — lets the assistant overwrite a named fact
  -- ("timezone") instead of accumulating stale duplicates. A NULL key never
  -- conflicts (Postgres treats NULLs as distinct in a unique constraint), so
  -- unkeyed memories accumulate freely; a plain constraint (not a partial index)
  -- is also what lets `upsert(..., { onConflict: 'owner_id,key' })` infer it.
  constraint user_memories_owner_key_uniq unique (owner_id, key)
);
create index user_memories_owner_idx on public.user_memories (owner_id, created_at desc);

alter table public.user_memories enable row level security;
grant select, insert, update, delete on public.user_memories to authenticated;

-- Owner-only across the board — memory is personal context, not shared content.
-- (Admins intentionally do NOT get to read other people's memories here.)
create policy "Read own memories"
  on public.user_memories for select
  using (owner_id = auth.uid());

create policy "Insert own memories"
  on public.user_memories for insert
  with check (owner_id = auth.uid());

create policy "Update own memories"
  on public.user_memories for update
  using (owner_id = auth.uid());

create policy "Delete own memories"
  on public.user_memories for delete
  using (owner_id = auth.uid());

create trigger user_memories_set_updated_at
  before update on public.user_memories
  for each row execute function public.set_updated_at();

-- Live UI: the Memory page subscribes so tool-written memories appear instantly.
alter publication supabase_realtime add table public.user_memories;

-- ---------------------------------------------------------------------------
-- Seed the memory builtins (assistant + all three agent loops). Same insert
-- shape as 0041_todos.sql; idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'remember',
  'Save a durable fact about the current user so you can recall it in future conversations (e.g. a preference, their role, their timezone). Optionally pass a short `key` to overwrite an existing fact of the same kind instead of adding a duplicate.',
  '{"type":"object","properties":{"content":{"type":"string","description":"The fact to remember, in plain language."},"key":{"type":"string","description":"Optional short label (e.g. \"timezone\", \"tone\"); saving with an existing key overwrites that fact."}},"required":["content"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'remember');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_memories',
  'List the durable facts you have remembered about the current user (with their ids, for updating or forgetting).',
  '{"type":"object","properties":{"limit":{"type":"integer","description":"Max memories to return (default 100)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_memories');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_memory',
  'Update a remembered fact by its id (pass the new content).',
  '{"type":"object","properties":{"id":{"type":"string","description":"The memory id."},"content":{"type":"string","description":"The new content."}},"required":["id","content"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_memory');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'forget',
  'Delete a remembered fact by its id (use when it is outdated or the user asks you to forget it).',
  '{"type":"object","properties":{"id":{"type":"string","description":"The memory id to delete."}},"required":["id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'forget');
