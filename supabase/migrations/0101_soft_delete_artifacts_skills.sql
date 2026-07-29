-- 0101_soft_delete_artifacts_skills.sql
-- ---------------------------------------------------------------------------
-- Soft delete (archive) + a recovery area for artifacts and skills, and give
-- the internal assistant + the external MCP server the ability to delete AND
-- archive both.
--
-- Model: a nullable `deleted_at` column is the archive flag. A row with
-- `deleted_at` set is "archived / trashed" — hidden from every normal read but
-- still recoverable by its owner. Clearing `deleted_at` restores it; a real row
-- DELETE is the permanent removal.
--
-- Read visibility: the owner still sees their own archived rows (that IS the
-- recovery area — the frontend filters them out of normal lists and queries
-- them explicitly for a Trash view). Non-owners (workspace members, anonymous
-- share viewers, admins) never see archived rows. Enforced by recreating the
-- SELECT policies with a `deleted_at is null` guard on every non-owner branch,
-- plus the security-definer share RPCs (which bypass RLS) get the same guard so
-- a password-protected archived artifact can't be unlocked.
--
-- Tools: seeds delete_artifact / restore_artifact / restore_skill as is_builtin
-- tools and re-describes delete_skill / list_artifacts / list_skills so the
-- in-app assistant, the scheduler/webhook/Slack loops, and an external Claude
-- (over MCP) can archive, restore, and permanently delete. Handlers live in
-- supabase/functions/_shared/builtins.ts (the MCP server delegates to them).
-- ---------------------------------------------------------------------------

-- 1. The archive flag on both tables.
alter table public.artifacts add column if not exists deleted_at timestamptz;
alter table public.skills    add column if not exists deleted_at timestamptz;

-- Partial indexes so the recovery (archived-only) listings stay cheap without
-- weighing down the hot path (normal reads scan the existing owner indexes).
create index if not exists artifacts_archived_idx
  on public.artifacts (owner_id, deleted_at desc) where deleted_at is not null;
create index if not exists skills_archived_idx
  on public.skills (owner_id, deleted_at desc) where deleted_at is not null;

-- 2. Recreate the artifacts SELECT policy: owner sees everything they own
-- (including their archive), everyone else only sees NON-archived shared rows.
drop policy if exists "Read own or shared artifacts" on public.artifacts;
create policy "Read own or shared artifacts"
  on public.artifacts for select
  using (
    owner_id = auth.uid()
    or (
      deleted_at is null
      and (
        (visibility = 'workspace' and auth.role() = 'authenticated')
        or (visibility in ('unlisted', 'public') and share_password_hash is null)
        or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
      )
    )
  );

-- 3. Recreate the skills SELECT policy: owner sees their own (archive included),
-- always-on prompts stay readable by everyone but ONLY while not archived.
drop policy if exists "Read own or always-on prompts" on public.skills;
create policy "Read own or always-on prompts"
  on public.skills for select
  using (owner_id = auth.uid() or (auto_apply = true and deleted_at is null));

-- 4. The public share RPCs are security-definer (they bypass RLS), so add the
-- same archive guard: an archived artifact is not found / cannot be unlocked.
create or replace function public.artifact_share_meta(p_slug text)
returns table (found boolean, requires_password boolean)
language sql
stable
security definer
set search_path = public
as $$
  select true, (a.share_password_hash is not null)
  from public.artifacts a
  where a.public_slug = p_slug and a.visibility <> 'private' and a.deleted_at is null
  limit 1;
$$;

create or replace function public.get_shared_artifact(p_slug text, p_password text default null)
returns table (
  id uuid,
  title text,
  type public.artifact_type,
  language text,
  content text,
  visibility public.visibility,
  public_slug text,
  data jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select a.id, a.title, a.type, a.language, a.content, a.visibility,
         a.public_slug, a.data, a.created_at, a.updated_at
  from public.artifacts a
  where a.public_slug = p_slug
    and a.visibility <> 'private'
    and a.deleted_at is null
    and (
      a.share_password_hash is null
      or (p_password is not null and a.share_password_hash = extensions.crypt(p_password, a.share_password_hash))
    )
  limit 1;
$$;

grant execute on function public.artifact_share_meta(text) to anon, authenticated;
grant execute on function public.get_shared_artifact(text, text) to anon, authenticated;

-- 5. Seed / re-describe the lifecycle tools (idempotent).

-- delete_artifact (NEW) — archive by default, permanent removal on demand.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'delete_artifact',
  'Delete an artifact you own (by id or exact title). By default this ARCHIVES it (a soft delete): the artifact is hidden from all normal views and share links but stays recoverable with restore_artifact. Pass permanent:true to remove it for good (cannot be undone). Owner only.',
  '{"type":"object","properties":{"artifact":{"type":"string","description":"The artifact id or its exact title."},"permanent":{"type":"boolean","description":"true = delete permanently (irreversible); default false = archive (recoverable)."}},"required":["artifact"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'delete_artifact');

-- restore_artifact (NEW) — pull an archived artifact back out of the trash.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'restore_artifact',
  'Restore (un-archive) an artifact you previously archived, by id or exact title. It becomes visible in normal views again. Owner only.',
  '{"type":"object","properties":{"artifact":{"type":"string","description":"The archived artifact id or its exact title."}},"required":["artifact"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'restore_artifact');

-- restore_skill (NEW) — pull an archived skill/prompt back out of the trash.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'restore_skill',
  'Restore (un-archive) a skill or always-on prompt you previously archived, by id or exact name. Personal skills restorable by their owner; always-on prompts require admin.',
  '{"type":"object","properties":{"skill":{"type":"string","description":"The archived skill/prompt id or its exact name."}},"required":["skill"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'restore_skill');

-- delete_skill — now archives by default (recoverable), permanent on demand.
update public.tools
set description = 'Delete a skill or always-on prompt (by id or exact name). By default this ARCHIVES it (a soft delete): it is hidden from normal views but recoverable with restore_skill. Pass permanent:true to remove it for good (irreversible). Personal skills are deletable by their owner; always-on prompts require admin. Built-in prompts cannot be deleted.',
    input_schema = '{"type":"object","properties":{"skill":{"type":"string","description":"The skill/prompt id or its exact name."},"permanent":{"type":"boolean","description":"true = delete permanently (irreversible); default false = archive (recoverable)."}},"required":["skill"]}'::jsonb
where name = 'delete_skill' and is_builtin = true;

-- list_artifacts — expose the `archived` filter (the recovery area).
update public.tools
set input_schema = '{"type":"object","properties":{"collection":{"type":"string","description":"Optional collection name or id to filter by."},"title_contains":{"type":"string","description":"Optional case-insensitive substring of the title."},"type":{"type":"string","enum":["markdown","code","html","text"],"description":"Optional artifact type filter."},"archived":{"type":"boolean","description":"true = list only ARCHIVED artifacts (the recovery area); default false = only live artifacts."},"limit":{"type":"number","description":"Max rows (default 20, max 100)."}}}'::jsonb
where name = 'list_artifacts' and is_builtin = true;

-- list_skills — expose the `archived` filter (the recovery area).
update public.tools
set input_schema = '{"type":"object","properties":{"always_on":{"type":"boolean","description":"true = only always-on prompts; false = only on-demand skills; omit = both."},"query":{"type":"string","description":"Optional case-insensitive substring of the name/description."},"archived":{"type":"boolean","description":"true = list only ARCHIVED skills/prompts (the recovery area); default false = only live ones."},"limit":{"type":"number","description":"Max rows (default 50, max 200)."}}}'::jsonb
where name = 'list_skills' and is_builtin = true;
