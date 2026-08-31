-- 0120_soft_delete_collections.sql
-- ---------------------------------------------------------------------------
-- Soft delete (archive) + a recovery area for collections.
--
-- Model: a nullable `deleted_at` column is the archive flag. A row with
-- `deleted_at` set is "archived / trashed" — hidden from every normal read but
-- still recoverable by its owner. Clearing `deleted_at` restores it; a real row
-- DELETE is the permanent removal.
--
-- Read visibility: the owner still sees their own archived collections (that IS
-- the recovery area — the frontend filters them out of normal lists and queries
-- them explicitly for a Trash view). Non-owners (workspace members, admins)
-- never see archived collections. Enforced by recreating the SELECT policy with
-- a `deleted_at is null` guard on every non-owner branch.
--
-- Join tables: collection_artifacts, collection_files, collection_todos,
-- collection_links, collection_whiteboards, collection_card_boards,
-- collection_tables, and collection_inbox_messages all inherit the archive
-- state — their policies rely on the collection being visible, so archived
-- collections are automatically excluded from context injection, searches, etc.
--
-- Service-role reads: edge functions (_shared/collections.ts,
-- _shared/builtins.ts, etc.) must filter `deleted_at is null` in code since
-- RLS is bypassed.
--
-- Tools: seeds delete_collection / restore_collection as is_builtin tools and
-- updates list_collections to expose an `archived` filter. Handlers live in
-- supabase/functions/_shared/builtins.ts (the MCP server delegates to them).
-- ---------------------------------------------------------------------------

-- 1. The archive flag.
alter table public.collections add column if not exists deleted_at timestamptz;

-- Partial index so the recovery (archived-only) listings stay cheap without
-- weighing down the hot path (normal reads scan the existing owner index).
create index if not exists collections_archived_idx
  on public.collections (owner_id, deleted_at desc) where deleted_at is not null;

-- 2. Recreate the collections SELECT policy: owner sees everything they own
-- (including their archive), everyone else only sees NON-archived collections.
drop policy if exists "Read own or shared collections" on public.collections;
create policy "Read own or shared collections"
  on public.collections for select
  using (
    owner_id = auth.uid()
    or (
      deleted_at is null
      and (
        visibility = 'workspace'
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
      )
    )
  );

-- 3. No changes needed to the join table policies — they already rely on
-- "exists (select 1 from public.collections c where c.id = collection_id)",
-- which is itself filtered by the SELECT policy above, so archived collections
-- are automatically hidden from workspace members and admins.

-- 4. Seed / re-describe the lifecycle tools (idempotent).

-- delete_collection (NEW) — archive by default, permanent removal on demand.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'delete_collection',
  'Delete a collection you own (by id or exact name). By default this ARCHIVES it (a soft delete): the collection is hidden from all normal views and context injection but stays recoverable with restore_collection. Pass permanent:true to remove it for good (irreversible). Owner only.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"The collection id or its exact name."},"permanent":{"type":"boolean","description":"true = delete permanently (irreversible); default false = archive (recoverable)."}},"required":["collection"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'delete_collection');

-- restore_collection (NEW) — pull an archived collection back out of the trash.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'restore_collection',
  'Restore (un-archive) a collection you previously archived, by id or exact name. It becomes visible in normal views and available for context injection again. Owner only.',
  '{"type":"object","properties":{"collection":{"type":"string","description":"The archived collection id or its exact name."}},"required":["collection"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'restore_collection');

-- list_collections — expose the `archived` filter (the recovery area).
update public.tools
set input_schema = '{"type":"object","properties":{"archived":{"type":"boolean","description":"true = list only ARCHIVED collections (the recovery area); default false = only live collections."},"limit":{"type":"number","description":"Max rows (default 50, max 200)."}}}'::jsonb
where name = 'list_collections' and is_builtin = true;
