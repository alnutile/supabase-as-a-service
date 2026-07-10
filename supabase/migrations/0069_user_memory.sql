-- Per-user memory — a durable, personal profile the assistant carries across
-- chats so a new conversation starts from what it already knows about you
-- (your name, defaults, tone, ongoing projects, standing preferences) instead
-- of a blank slate.
--
-- Shape mirrors the rest of the system rather than inventing a new pattern:
--   * A `user_memories` row is OWNER-ONLY (like conversations / messages /
--     files). Memory is personal — deliberately NOT the private/workspace model
--     of todos/links; one user's remembered facts never leak into another's
--     context. RLS is `owner_id = auth.uid()` across the board.
--   * The assistant reads/writes it through seeded `is_builtin` tools
--     (remember / list_memories / update_memory / forget) shared by all three
--     agent loops via runBuiltin (supabase/functions/_shared/memory.ts), and the
--     MCP server exposes the same names — so chat, scheduled/webhook agents, and
--     an external Claude all use one code path (the tables/artifacts convention).
--   * Every write emits an `events` row (memory.created / memory.updated) through
--     emit_event (0063) at PRIVATE visibility, so the automation layer can react
--     ("when a memory is saved, …") AND a listener's run_tool → remember can
--     write memory on any event. The event is the integration point in both
--     directions.
--   * The chat + scheduler loops inject the caller's memories into the system
--     prompt (loadUserMemories) so every new chat / scheduled run is pre-warmed.
--     Webhook + Slack loops deliberately do NOT auto-inject — they face external
--     callers, and personal memory must not bleed into a reply to an untrusted
--     source (those agents can still read it via list_memories if scoped in).
--
-- An optional `key` gives a memory a stable slug so remember() upserts in place
-- ("preferred_name" set once, refined later) instead of piling up duplicates;
-- `pinned` floats the load-bearing ones to the top of what gets injected.

-- ---------------------------------------------------------------------------
-- user_memories
-- ---------------------------------------------------------------------------
create table public.user_memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  -- Optional stable slug for upsert/dedup, e.g. 'preferred_name', 'tone'.
  key text,
  -- Freeform bucket (preference | fact | context | project | general). Kept as
  -- plain text on purpose: the model shouldn't have a write rejected for coining
  -- a sensible new category.
  category text not null default 'general',
  pinned boolean not null default false,
  -- Provenance, e.g. {"origin":"chat","conversation_id":"…"}.
  source jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index user_memories_owner_idx on public.user_memories (owner_id, pinned desc, updated_at desc);
-- One memory per (owner, key) so remember() can upsert by key. Partial: rows
-- without a key are unconstrained (free-form memories can repeat).
create unique index user_memories_owner_key_uidx
  on public.user_memories (owner_id, key) where key is not null;

alter table public.user_memories enable row level security;
grant select, insert, update, delete on public.user_memories to authenticated;

-- Owner-only — memory is personal (mirrors conversations/files, NOT the
-- private/workspace collaboration model).
create policy "Owners read their memories"
  on public.user_memories for select
  using (owner_id = auth.uid());
create policy "Owners insert their memories"
  on public.user_memories for insert
  with check (owner_id = auth.uid());
create policy "Owners update their memories"
  on public.user_memories for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
create policy "Owners delete their memories"
  on public.user_memories for delete
  using (owner_id = auth.uid());

create trigger user_memories_set_updated_at
  before update on public.user_memories
  for each row execute function public.set_updated_at();

-- Live updates for the Memory page (owner-scoped by RLS).
alter publication supabase_realtime add table public.user_memories;

-- ---------------------------------------------------------------------------
-- Events: memory.created + memory.updated (private visibility). Mirrors the
-- per-entity trigger functions in 0063. Emitting these lets the automation
-- layer react to memory changes; a listener's run_tool → remember closes the
-- loop the other way (write memory in response to any event).
-- ---------------------------------------------------------------------------
create or replace function public.emit_memory_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event(
    case when tg_op = 'INSERT' then 'memory.created' else 'memory.updated' end,
    'memory', new.id, new.owner_id,
    (case when tg_op = 'INSERT' then 'Memory saved: ' else 'Memory updated: ' end) || left(new.content, 80),
    jsonb_build_object('category', new.category, 'key', new.key),
    'private'
  );
  return new;
end; $$;
create trigger trg_emit_memory
  after insert or update on public.user_memories
  for each row execute function public.emit_memory_event();

-- ---------------------------------------------------------------------------
-- Seed the memory builtins (assistant + all three agent loops + MCP). Same
-- insert shape as 0041_todos.sql; idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'remember',
  'Save a durable fact or preference about THIS user so future chats start already knowing it — their name, defaults, tone, tools/stack, ongoing projects, standing preferences ("always answer in metric", "I manage the Acme account"). Memories are private to the user and injected at the start of every new chat. Pass a stable `key` (e.g. "preferred_name") to update that memory in place instead of duplicating. Do NOT store secrets/passwords or one-off, ephemeral details.',
  '{"type":"object","properties":{"content":{"type":"string","description":"The fact/preference to remember, phrased as a durable statement."},"key":{"type":"string","description":"Optional stable slug (e.g. \"preferred_name\", \"tone\"); reusing it overwrites that memory instead of adding a new one."},"category":{"type":"string","description":"Optional bucket: preference | fact | context | project | general (default general)."},"pinned":{"type":"boolean","description":"Optional — pin an important memory so it is always injected first."}},"required":["content"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'remember');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_memories',
  'List what you remember about this user (most important/recent first), with ids so you can update or forget them. Optionally filter by category or a text query.',
  '{"type":"object","properties":{"category":{"type":"string","description":"Optional category filter."},"query":{"type":"string","description":"Optional case-insensitive substring to match in the memory text."},"limit":{"type":"number","description":"Max rows (default 50, max 200)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_memories');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_memory',
  'Update an existing memory (identify it by id, or by its key). Change the content, category, or pinned state.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The memory id (or use key)."},"key":{"type":"string","description":"The memory key (alternative to id)."},"content":{"type":"string"},"category":{"type":"string"},"pinned":{"type":"boolean"}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_memory');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'forget',
  'Delete a memory the user no longer wants remembered (identify it by id, or by its key).',
  '{"type":"object","properties":{"id":{"type":"string","description":"The memory id (or use key)."},"key":{"type":"string","description":"The memory key (alternative to id)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'forget');

-- ---------------------------------------------------------------------------
-- Seed an always-on prompt teaching the memory discipline (when to save, what
-- NOT to save, how it's injected). Same shape as the 0054 auto_apply skill.
-- ---------------------------------------------------------------------------
insert into public.skills (owner_id, name, description, instructions, auto_apply, is_builtin, output_mode)
select
  (select id from public.profiles order by created_at asc limit 1),
  'User memory',
  'Built-in. Teaches the assistant to remember durable facts/preferences about the user with the remember tool, and how the injected memory block works.',
  $prompt$USER MEMORY

You can carry knowledge about THIS user across conversations. When a new chat starts, everything currently remembered about the user is injected into your context under a "What you remember about this user" heading — treat it as already-known background, not something to re-ask.

Save a memory (the `remember` tool) when you learn something durable and reusable:
- Identity & defaults: their name, role, team, timezone, the stack/tools they use.
- Standing preferences: tone, format ("bullet points", "answer in metric"), languages, do/don't.
- Ongoing context: projects they're working on, accounts/clients they own, recurring goals.

Do NOT save:
- Secrets, passwords, API keys, or anything sensitive (there's a Vault for credentials).
- One-off, ephemeral details that won't matter next time.
- Something already remembered — update it instead.

Discipline:
- Prefer a stable `key` for facts that get refined over time (e.g. key "preferred_name") so the memory updates in place instead of duplicating.
- When the user corrects or changes a standing fact, `update_memory` (or `remember` with the same key). When they say to forget something, use `forget`.
- Save quietly in the background — a brief "I'll remember that" is fine, but don't turn every message into a memory prompt.$prompt$,
  true,
  true,
  'reply'
where not exists (select 1 from public.skills where name = 'User memory' and is_builtin = true);
