-- Collections: named groups ("tags") of artifacts.
--
-- A user selects many artifacts on the Artifacts page and files them into one or
-- more collections, then in Chat picks a collection to scope the conversation's
-- context to just that content ("chat with my blog posts"). Collections are also
-- an INGESTION target: external systems (via MCP) push content in as artifacts and
-- file them into a collection, so a workspace can centralize content that lives
-- elsewhere — blog posts, YouTube transcripts, notes — in one place to chat with.
--
-- Access model mirrors `user_tables`: a collection is `private` (owner + admins)
-- or `workspace` (every member can read, and — like a shared base — collaborate).
-- Membership lives in a join table whose RLS simply inherits the collection's
-- visibility, so the access logic lives in ONE place (the collection's RLS).

-- ---------------------------------------------------------------------------
-- Collections
-- ---------------------------------------------------------------------------
create table public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text not null default '',
  color text,
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index collections_owner_idx on public.collections (owner_id, updated_at desc);

alter table public.collections enable row level security;
grant select, insert, update, delete on public.collections to authenticated;

-- Read your own collections, any workspace-shared one, or (admins) all of them.
create policy "Read own or shared collections"
  on public.collections for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create policy "Insert own collections"
  on public.collections for insert
  with check (owner_id = auth.uid());

create policy "Update own collections"
  on public.collections for update
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create policy "Delete own collections"
  on public.collections for delete
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- ---------------------------------------------------------------------------
-- Membership (artifact ↔ collection, many-to-many)
-- ---------------------------------------------------------------------------
create table public.collection_artifacts (
  collection_id uuid not null references public.collections (id) on delete cascade,
  artifact_id uuid not null references public.artifacts (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (collection_id, artifact_id)
);
create index collection_artifacts_artifact_idx on public.collection_artifacts (artifact_id);

alter table public.collection_artifacts enable row level security;
grant select, insert, delete on public.collection_artifacts to authenticated;

-- A membership row is visible when its collection is visible (the EXISTS is
-- itself filtered by the collections SELECT policy above, so this inherits it).
create policy "Read memberships of visible collections"
  on public.collection_artifacts for select
  using (exists (select 1 from public.collections c where c.id = collection_id));

-- Anyone who can collaborate on the collection (owner, workspace members, admins)
-- may file artifacts into it or remove them — that is what makes a shared
-- collection a centralizing surface the whole team can build up.
create policy "Add to collaborable collections"
  on public.collection_artifacts for insert
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

create policy "Remove from collaborable collections"
  on public.collection_artifacts for delete
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
