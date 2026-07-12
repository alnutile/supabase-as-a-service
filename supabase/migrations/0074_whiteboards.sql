-- Whiteboards — the "Planner" area: an Excalidraw canvas you plan on, that saves
-- to a structured scene the AI can read, so it behaves like an artifact — it can
-- be filed into collections, chatted with (its text/shapes are injected as
-- primary context), and edited by the assistant. Multiple members edit the same
-- board at the same time (Supabase Realtime broadcast + presence in the editor;
-- this table is the durable store, autosaved as people draw).
--
-- Shape mirrors links / todos rather than inventing a new pattern:
--   * A `whiteboards` row is `title` + a `scene` jsonb (the Excalidraw scene:
--     {elements, appState, files}). Visibility is `private` (owner + admins) or
--     `workspace` (every member can see AND collaborate) — the same
--     collaboration model as todos/links/collections/user_tables.
--   * `collection_whiteboards` is the many-to-many join that files a board into
--     collections (exact mirror of collection_links); its RLS inherits the parent
--     collection's visibility, so access logic lives in ONE place.
--   * Every write emits an `events` row (whiteboard.created / whiteboard.updated)
--     via emit_event (0063), and the generic collection.item_added trigger learns
--     `collection_whiteboards`, so the automation layer can react.
--   * The table joins the realtime publication so the editor and any open board
--     panel refresh live when a teammate (or the assistant's update_whiteboard)
--     changes it — the same durable-sync half used by artifacts.data.
--   * The bottom seeds the `is_builtin` whiteboard tools (create_whiteboard /
--     list_whiteboards / get_whiteboard / update_whiteboard /
--     add_whiteboard_to_collection) so the in-app assistant and all three agent
--     loops (chat / webhook / scheduler) — and the MCP server — can read a board
--     as text and draw on it by writing Excalidraw elements. Same insert shape as
--     0041/0049/0069; idempotent via `where not exists`.

-- ---------------------------------------------------------------------------
-- whiteboards
-- ---------------------------------------------------------------------------
create table public.whiteboards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Untitled whiteboard',
  -- The Excalidraw scene: { elements: [...], appState: {...}, files: {...} }.
  -- A structured, AI-readable "file" — sceneToText extracts its text/shapes for
  -- context injection, and the assistant can write elements back to draw on it.
  scene jsonb not null default '{}'::jsonb,
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index whiteboards_owner_idx on public.whiteboards (owner_id, updated_at desc);

alter table public.whiteboards enable row level security;
grant select, insert, update, delete on public.whiteboards to authenticated;

-- Read own or workspace-shared (admins see all) — mirrors todos/links/collections.
create policy "Read own or shared whiteboards"
  on public.whiteboards for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create policy "Insert own whiteboards"
  on public.whiteboards for insert
  with check (owner_id = auth.uid());

-- Workspace = collaborate: members may edit shared boards at the same time.
create policy "Update own or shared whiteboards"
  on public.whiteboards for update
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Deleting is more destructive than editing — owner or admin only.
create policy "Delete own whiteboards"
  on public.whiteboards for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create trigger whiteboards_set_updated_at
  before update on public.whiteboards
  for each row execute function public.set_updated_at();

-- Live updates for the Planner editor + any open board panel (RLS-scoped).
alter publication supabase_realtime add table public.whiteboards;

-- ---------------------------------------------------------------------------
-- Events: whiteboard.created + whiteboard.updated. Mirrors the per-entity
-- trigger functions in 0063; visibility follows the row so a shared board's
-- activity is workspace-visible and a private one stays private.
-- ---------------------------------------------------------------------------
create or replace function public.emit_whiteboard_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event(
    case when tg_op = 'INSERT' then 'whiteboard.created' else 'whiteboard.updated' end,
    'whiteboard', new.id, new.owner_id,
    (case when tg_op = 'INSERT' then 'Whiteboard created: ' else 'Whiteboard updated: ' end) || left(new.title, 80),
    jsonb_build_object('title', new.title),
    case when new.visibility = 'private' then 'private' else 'workspace' end
  );
  return new;
end; $$;
create trigger trg_emit_whiteboard
  after insert or update on public.whiteboards
  for each row execute function public.emit_whiteboard_event();

-- ---------------------------------------------------------------------------
-- collection_whiteboards (many-to-many; mirrors collection_links exactly)
-- ---------------------------------------------------------------------------
create table public.collection_whiteboards (
  collection_id uuid not null references public.collections (id) on delete cascade,
  whiteboard_id uuid not null references public.whiteboards (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, whiteboard_id)
);
create index collection_whiteboards_whiteboard_idx on public.collection_whiteboards (whiteboard_id);

alter table public.collection_whiteboards enable row level security;
grant select, insert, delete on public.collection_whiteboards to authenticated;

-- A membership row is visible when its parent collection is visible.
create policy "Read whiteboard memberships of visible collections"
  on public.collection_whiteboards for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

-- Anyone who can collaborate on the collection may file whiteboards into it.
create policy "Add whiteboards to collaborable collections"
  on public.collection_whiteboards for insert
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

create policy "Remove whiteboards from collaborable collections"
  on public.collection_whiteboards for delete
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
-- Teach the generic collection-membership trigger about `collection_whiteboards`
-- (re-declare the whole function so the case mapping stays in one place — same
-- convention as 0068), then attach it to the new join table.
-- ---------------------------------------------------------------------------
create or replace function public.emit_collection_item_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_item_type text;
  v_item_id uuid;
  v_owner uuid;
  v_vis text;
begin
  v_item_type := case tg_table_name
    when 'collection_artifacts' then 'artifact'
    when 'collection_files' then 'file'
    when 'collection_todos' then 'todo'
    when 'collection_links' then 'link'
    when 'collection_tables' then 'table'
    when 'collection_agents' then 'agent'
    when 'collection_whiteboards' then 'whiteboard'
    when 'collection_inbox_messages' then 'inbox_message'
    else 'item' end;
  v_item_id := (to_jsonb(new) ->> (v_item_type || '_id'))::uuid;
  select owner_id, visibility into v_owner, v_vis from public.collections where id = new.collection_id;
  perform public.emit_event(
    'collection.item_added', v_item_type, v_item_id,
    coalesce(new.added_by, v_owner),
    'Added a ' || v_item_type || ' to a collection',
    jsonb_build_object('collection_id', new.collection_id, 'item_type', v_item_type, 'item_id', v_item_id),
    case when coalesce(v_vis, 'workspace') = 'private' then 'private' else 'workspace' end
  );
  return new;
end; $$;

create trigger trg_emit_collection_whiteboard
  after insert on public.collection_whiteboards
  for each row execute function public.emit_collection_item_added();

-- ---------------------------------------------------------------------------
-- Seed the whiteboard builtins (assistant + all three agent loops + MCP). Same
-- insert shape as 0041/0049/0069; idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_whiteboard',
  'Create a whiteboard in the Planner — an Excalidraw canvas. Optionally seed it by passing `elements`: an array of Excalidraw element objects (each needs at least type, x, y; text elements need a `text`; rectangles/ellipses/diamonds need width/height). Use this to draw a diagram/flowchart/mind-map for the user. Optionally file it into a collection (by name; created if missing).',
  '{"type":"object","properties":{"title":{"type":"string","description":"The whiteboard title."},"elements":{"type":"array","description":"Optional array of Excalidraw element objects to seed the canvas with (type, x, y, width, height, text, …).","items":{"type":"object"}},"collection":{"type":"string","description":"Optional collection name (or id) to file this whiteboard into; created if missing."}},"required":["title"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_whiteboard');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_whiteboards',
  'List whiteboards (most recently updated first), with ids so you can read or update them. Optionally filter by collection name/id or a title substring.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."},"title_contains":{"type":"string","description":"Optional case-insensitive title substring filter."},"limit":{"type":"number","description":"Max rows (default 50, max 200)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_whiteboards');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'get_whiteboard',
  'Read a whiteboard as text: its title plus the text labels, shapes, and connections on the canvas (identify it by id, or by exact title). Use this before update_whiteboard so you evolve the current board instead of duplicating it.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The whiteboard id (or use title)."},"title":{"type":"string","description":"The exact whiteboard title (alternative to id)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'get_whiteboard');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_whiteboard',
  'Update a whiteboard (identify it by id, or by exact title). Rename it (`title`) and/or draw on it by passing `elements`, an array of Excalidraw element objects: with `mode:"replace"` (default) they become the whole canvas; with `mode:"append"` they are added to the existing elements. Call get_whiteboard first to see what is already there.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The whiteboard id (or use title)."},"title":{"type":"string","description":"The exact current title to find it by, OR (with id) the new title to rename it to."},"elements":{"type":"array","description":"Excalidraw element objects to draw.","items":{"type":"object"}},"mode":{"type":"string","enum":["replace","append"],"description":"replace (default) swaps the whole canvas; append adds to it."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_whiteboard');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_whiteboard_to_collection',
  'Add an existing whiteboard to a collection (both by name or id). The collection is created if it does not exist.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"whiteboard_id":{"type":"string","description":"The whiteboard id to add."}},"required":["collection","whiteboard_id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_whiteboard_to_collection');
