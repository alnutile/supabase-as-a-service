-- Files in collections: allow users to read files that are in collections they
-- have access to. The bug: the files table's RLS policy only checked owner_id,
-- so when User A added a file to a workspace collection, User B could see the
-- collection_files join row but not the actual file data (blocked by files RLS).
--
-- Fix: add a SELECT policy on files that grants access when the file is in a
-- collection the user can see (own collection, workspace collection, or admin).
-- This mirrors how artifacts work when shared through collections.

-- Drop the old blanket "Owners manage their files" policy and replace it with
-- more granular policies that allow collection-based access.

drop policy if exists "Owners manage their files" on public.files;

-- Owners can manage their own files
create policy "Owners manage their files"
  on public.files for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Users can read files in collections they have access to
-- This policy checks if the file is in any collection that the user can see
-- (own collection, workspace collection, or admin access)
create policy "Read files in accessible collections"
  on public.files for select
  using (
    exists (
      select 1
      from public.collection_files cf
      join public.collections c on c.id = cf.collection_id
      where cf.file_id = files.id
        and (
          c.owner_id = auth.uid()
          or c.visibility = 'workspace'
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
        )
    )
  );

-- Users can read unlisted and public files (for sharing)
-- This handles files shared via direct links outside of collections
create policy "Read shared files"
  on public.files for select
  using (visibility in ('unlisted', 'public'));
