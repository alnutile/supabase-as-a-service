-- Card boards — the second Planner surface (lives under Assets, next to
-- Whiteboards): a free-form wall of movable cards for laying out ideas by
-- priority. Deliberately NOT a Kanban (no fixed columns/lanes) — you dump cards
-- and drag them anywhere; position IS the ranking. Low-friction on purpose:
-- double-click to add a card, drag to move, × to delete.
--
-- Shape mirrors whiteboards (0074) rather than inventing a new pattern:
--   * A `card_boards` row = `title` + a `cards` jsonb array. Each card is
--     `{id, text, color, x, y}` — a structured, AI-readable "file" (cardsToText
--     renders it top-to-bottom as a prioritized list). Visibility is `private`
--     (owner + admins) or `workspace` (every member can see AND collaborate).
--   * `collection_card_boards` is the many-to-many join (mirror of
--     collection_whiteboards); RLS inherits the parent collection's visibility.
--   * Joins the realtime publication (live multi-user card shuffling), emits
--     card_board.created/updated events, and the generic collection.item_added
--     trigger learns the join.
--   * Seeds the `is_builtin` tools create_card_board / list_card_boards /
--     get_card_board / add_cards / add_card_board_to_collection so chat +
--     agents + the MCP server can dump ideas as cards and read a board.

-- ---------------------------------------------------------------------------
-- card_boards
-- ---------------------------------------------------------------------------
create table public.card_boards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Untitled board',
  -- Array of cards: [{ id, text, color, x, y }, …]. A structured, AI-readable
  -- file — cardsToText renders it as a prioritized list (top = higher priority).
  cards jsonb not null default '[]'::jsonb,
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index card_boards_owner_idx on public.card_boards (owner_id, updated_at desc);

alter table public.card_boards enable row level security;
grant select, insert, update, delete on public.card_boards to authenticated;

-- Read own or workspace-shared (admins see all) — mirrors whiteboards/todos.
create policy "Read own or shared card boards"
  on public.card_boards for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create policy "Insert own card boards"
  on public.card_boards for insert
  with check (owner_id = auth.uid());

-- Workspace = collaborate: members may move/add cards on shared boards at once.
create policy "Update own or shared card boards"
  on public.card_boards for update
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create policy "Delete own card boards"
  on public.card_boards for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create trigger card_boards_set_updated_at
  before update on public.card_boards
  for each row execute function public.set_updated_at();

-- Live updates for the editor + any open board (RLS-scoped).
alter publication supabase_realtime add table public.card_boards;

-- ---------------------------------------------------------------------------
-- Events: card_board.created + card_board.updated. Mirrors 0074.
-- ---------------------------------------------------------------------------
create or replace function public.emit_card_board_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_event(
    case when tg_op = 'INSERT' then 'card_board.created' else 'card_board.updated' end,
    'card_board', new.id, new.owner_id,
    (case when tg_op = 'INSERT' then 'Card board created: ' else 'Card board updated: ' end) || left(new.title, 80),
    jsonb_build_object('title', new.title),
    case when new.visibility = 'private' then 'private' else 'workspace' end
  );
  return new;
end; $$;
create trigger trg_emit_card_board
  after insert or update on public.card_boards
  for each row execute function public.emit_card_board_event();

-- ---------------------------------------------------------------------------
-- collection_card_boards (many-to-many; mirrors collection_whiteboards exactly)
-- ---------------------------------------------------------------------------
create table public.collection_card_boards (
  collection_id uuid not null references public.collections (id) on delete cascade,
  card_board_id uuid not null references public.card_boards (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, card_board_id)
);
create index collection_card_boards_board_idx on public.collection_card_boards (card_board_id);

alter table public.collection_card_boards enable row level security;
grant select, insert, delete on public.collection_card_boards to authenticated;

create policy "Read card-board memberships of visible collections"
  on public.collection_card_boards for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

create policy "Add card boards to collaborable collections"
  on public.collection_card_boards for insert
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

create policy "Remove card boards from collaborable collections"
  on public.collection_card_boards for delete
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
-- Teach the generic collection-membership trigger about `collection_card_boards`
-- (re-declare the whole function so the case mapping stays in one place — same
-- convention as 0068/0074), then attach it to the new join table.
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
    when 'collection_card_boards' then 'card_board'
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

create trigger trg_emit_collection_card_board
  after insert on public.collection_card_boards
  for each row execute function public.emit_collection_item_added();

-- ---------------------------------------------------------------------------
-- Seed the card-board builtins (assistant + all three agent loops + MCP). Same
-- insert shape as 0074; idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_card_board',
  'Create a card board in the Planner — a free-form wall of movable cards for laying out ideas by priority (not a Kanban). Optionally seed it with `cards`: an array of {text, color?} (color one of yellow|pink|green|blue|purple|gray). Optionally file it into a collection (by name; created if missing).',
  '{"type":"object","properties":{"title":{"type":"string","description":"The board title."},"cards":{"type":"array","description":"Optional cards to seed: each {text, color?}.","items":{"type":"object","properties":{"text":{"type":"string"},"color":{"type":"string"}},"required":["text"]}},"collection":{"type":"string","description":"Optional collection name (or id) to file this board into; created if missing."}},"required":["title"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_card_board');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_card_boards',
  'List card boards (most recently updated first) with ids. Optionally filter by collection name/id or a title substring.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."},"title_contains":{"type":"string","description":"Optional case-insensitive title substring."},"limit":{"type":"number","description":"Max rows (default 50, max 200)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_card_boards');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'get_card_board',
  'Read a card board as text: its title plus the cards on it, ordered top-to-bottom (higher = higher priority). Identify it by id or exact title.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The board id (or use title)."},"title":{"type":"string","description":"The exact board title (alternative to id)."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'get_card_board');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_cards',
  'Add cards to an existing board (identify it by id or exact title). Pass `cards`: an array of {text, color?} (color one of yellow|pink|green|blue|purple|gray). The cards are auto-positioned on the canvas; the user can then drag them to rank by priority.',
  '{"type":"object","properties":{"id":{"type":"string","description":"The board id (or use title)."},"title":{"type":"string","description":"The exact board title (alternative to id)."},"cards":{"type":"array","description":"Cards to add: each {text, color?}.","items":{"type":"object","properties":{"text":{"type":"string"},"color":{"type":"string"}},"required":["text"]}}},"required":["cards"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_cards');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_card_board_to_collection',
  'Add an existing card board to a collection (both by name or id). The collection is created if it does not exist.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"card_board_id":{"type":"string","description":"The card board id to add."}},"required":["collection","card_board_id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_card_board_to_collection');
