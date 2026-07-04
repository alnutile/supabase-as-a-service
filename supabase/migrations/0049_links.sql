-- Links — a shared bookmarks area (route /links, sidebar under Assets) that
-- plugs into the same concepts the rest of the system already uses.
--
-- A `links` row is "remember/share this URL": the url plus metadata the system
-- fills in automatically when the link is added (page title, meta/OpenGraph
-- description, preview image, favicon — fetched server-side by the `link-meta`
-- edge function or the save_link builtin, since the browser can't read
-- cross-origin pages). `screenshot_path` is reserved for a captured page
-- screenshot (a storage path) — the capture pipeline lands later; the column is
-- here so the data model and UI are ready to show one the moment it exists.
--
-- Visibility mirrors `todos` / `collections` / `user_tables`: `private`
-- (owner + admins) or `workspace` (every member can see AND collaborate).
--
-- `collection_links` is the many-to-many join that lets a link be filed into
-- collections, exactly like collection_artifacts / collection_todos. Its RLS
-- inherits the parent collection's visibility (the access logic lives in ONE
-- place, the collections table).
--
-- The bottom of this file seeds the `is_builtin` link tools (save_link /
-- list_links / add_link_to_collection) so the in-app assistant and the
-- chat/scheduler/webhook agent loops can capture links too, same shape as the
-- to-do builtins in 0041.

-- ---------------------------------------------------------------------------
-- links
-- ---------------------------------------------------------------------------
create table public.links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  url text not null,
  title text not null default '',
  description text not null default '',
  image_url text,          -- og:image (or similar) preview, absolute URL
  favicon_url text,        -- site icon, absolute URL
  screenshot_path text,    -- reserved: storage path of a captured screenshot
  notes text not null default '',
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index links_owner_idx on public.links (owner_id, created_at desc);

alter table public.links enable row level security;
grant select, insert, update, delete on public.links to authenticated;

-- Read own or workspace-shared (admins see all) — mirrors todos/collections.
create policy "Read own or shared links"
  on public.links for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create policy "Insert own links"
  on public.links for insert
  with check (owner_id = auth.uid());

-- Workspace = collaborate: members may edit shared links (fix a title, add notes).
create policy "Update own or shared links"
  on public.links for update
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Deleting is more destructive than editing — owner or admin only.
create policy "Delete own links"
  on public.links for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create trigger links_set_updated_at
  before update on public.links
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- collection_links (many-to-many; mirrors collection_todos exactly)
-- ---------------------------------------------------------------------------
create table public.collection_links (
  collection_id uuid not null references public.collections (id) on delete cascade,
  link_id uuid not null references public.links (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, link_id)
);
create index collection_links_link_idx on public.collection_links (link_id);

alter table public.collection_links enable row level security;
grant select, insert, delete on public.collection_links to authenticated;

-- A membership row is visible when its parent collection is visible.
create policy "Read link memberships of visible collections"
  on public.collection_links for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

-- Anyone who can collaborate on the collection may file links into it.
create policy "Add links to collaborable collections"
  on public.collection_links for insert
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

create policy "Remove links from collaborable collections"
  on public.collection_links for delete
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
-- Seed the link builtins (assistant + all three agent loops). Same insert
-- shape as 0041_todos.sql; idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'save_link',
  'Save a link (URL) to the Links area. The page title, description, preview image and favicon are fetched automatically from the URL. Optionally file it into a collection (by name; created if missing).',
  '{"type":"object","properties":{"url":{"type":"string","description":"The full http(s) URL to save."},"title":{"type":"string","description":"Optional title override (otherwise fetched from the page)."},"notes":{"type":"string","description":"Optional notes about why this link matters."},"collection":{"type":"string","description":"Optional collection name (or id) to file this link into; created if missing."}},"required":["url"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'save_link');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_links',
  'List saved links (optionally filter by collection name/id). Shows each link''s title, URL and description.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_links');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_link_to_collection',
  'Add an existing saved link to a collection (both by name or id). The collection is created if it does not exist.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"link_id":{"type":"string","description":"The link id to add."}},"required":["collection","link_id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_link_to_collection');
