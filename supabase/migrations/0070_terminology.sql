-- Terminology — a workspace-shared glossary of terms and definitions, with
-- collection membership so agents can understand domain-specific language in
-- context.
--
-- A `terminology` row is a term + definition + optional notes + source
-- provenance + visibility (private/workspace). Visibility mirrors todos/links:
-- `private` (owner + admins) or `workspace` (every member can see AND edit),
-- so a shared glossary works like a shared collection.
--
-- `collection_terminology` is the many-to-many join that lets terms be filed
-- into collections, exactly like `collection_todos` / `collection_links` — so a
-- collection you chat with can carry its terminology alongside its docs/tasks.
-- Its RLS inherits the parent collection's visibility.
--
-- The bottom of this file seeds the `is_builtin` terminology tools
-- (create_term / list_terms / update_term / delete_term /
-- add_term_to_collection) so the in-app assistant and agent loops can manage
-- terms, same shape as the todo/link builtins.

-- ---------------------------------------------------------------------------
-- terminology
-- ---------------------------------------------------------------------------
create table public.terminology (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  term text not null,
  definition text not null,
  notes text not null default '',
  source jsonb,
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index terminology_owner_idx on public.terminology (owner_id, term);
create index terminology_term_idx on public.terminology (lower(term));

alter table public.terminology enable row level security;
grant select, insert, update, delete on public.terminology to authenticated;

-- Read own or workspace-shared (admins see all) — mirrors todos/links.
create policy "Read own or shared terminology"
  on public.terminology for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create policy "Insert own terminology"
  on public.terminology for insert
  with check (owner_id = auth.uid());

-- Workspace = collaborate: members may edit shared terms.
create policy "Update own or shared terminology"
  on public.terminology for update
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Deleting is more destructive than editing — owner or admin only.
create policy "Delete own terminology"
  on public.terminology for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create trigger terminology_set_updated_at
  before update on public.terminology
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- collection_terminology (many-to-many; mirrors collection_todos exactly)
-- ---------------------------------------------------------------------------
create table public.collection_terminology (
  collection_id uuid not null references public.collections (id) on delete cascade,
  term_id uuid not null references public.terminology (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, term_id)
);
create index collection_terminology_term_idx on public.collection_terminology (term_id);

alter table public.collection_terminology enable row level security;
grant select, insert, delete on public.collection_terminology to authenticated;

-- A membership row is visible when its parent collection is visible.
create policy "Read term memberships of visible collections"
  on public.collection_terminology for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

-- Anyone who can collaborate on the collection may file terms into it.
create policy "Add terms to collaborable collections"
  on public.collection_terminology for insert
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

create policy "Remove terms from collaborable collections"
  on public.collection_terminology for delete
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
-- Seed the terminology builtins (assistant + all agent loops). Same insert
-- shape as todos/links builtins; idempotent via `where not exists`.
-- ---------------------------------------------------------------------------
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'create_term',
  'Create a terminology entry (term + definition). Optionally add notes and file it into a collection (by name; created if missing). Use this to capture domain-specific language.',
  '{"type":"object","properties":{"term":{"type":"string"},"definition":{"type":"string"},"notes":{"type":"string","description":"Optional additional context or examples."},"collection":{"type":"string","description":"Optional collection name (or id) to file this term into; created if missing."}},"required":["term","definition"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'create_term');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_terms',
  'List terminology entries (optionally filter by collection name/id or search by term). Shows term, definition, and notes.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."},"search":{"type":"string","description":"Optional term search filter."}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_terms');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'update_term',
  'Update a terminology entry: term, definition, or notes.',
  '{"type":"object","properties":{"id":{"type":"string"},"term":{"type":"string"},"definition":{"type":"string"},"notes":{"type":"string"}},"required":["id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'update_term');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'delete_term',
  'Delete a terminology entry (pass its id).',
  '{"type":"object","properties":{"id":{"type":"string","description":"The term id."}},"required":["id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'delete_term');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'add_term_to_collection',
  'Add an existing terminology entry to a collection (both by name or id). The collection is created if it does not exist.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"Collection name or id."},"term_id":{"type":"string","description":"The term id to add."}},"required":["collection","term_id"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'add_term_to_collection');
