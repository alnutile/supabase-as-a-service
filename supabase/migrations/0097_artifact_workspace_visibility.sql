-- Add 'workspace' visibility option to artifacts so they can be shared with
-- workspace members (like todos, links, collections) independently of the
-- public/unlisted external sharing options.

-- Add 'workspace' to the visibility enum.
alter type public.visibility add value 'workspace';

-- Drop and recreate the artifacts SELECT policy to handle workspace visibility.
-- The new policy allows:
--   1. Owner can see their own artifacts
--   2. Authenticated users can see artifacts marked 'workspace'
--   3. Anyone (including anon) can see artifacts marked 'unlisted' or 'public'
--   4. Admins can see all artifacts
drop policy if exists "Read own or shared artifacts" on public.artifacts;
create policy "Read own or shared artifacts"
  on public.artifacts for select
  using (
    owner_id = auth.uid()
    or (visibility = 'workspace' and auth.role() = 'authenticated')
    or visibility in ('unlisted', 'public')
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Update policy should also allow workspace members to update workspace-shared artifacts
-- if they can collaborate on them (similar to todos/links).
-- For now, keep update as owner-only to maintain the current behavior where only
-- the owner can edit. This can be revisited if collaborative editing is desired.
-- (The current policy "Owners update artifacts" remains unchanged.)
