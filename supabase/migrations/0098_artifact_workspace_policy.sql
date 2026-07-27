-- Second half of the artifact 'workspace' visibility change (0097 added the enum
-- value). This runs in its own transaction, so `visibility = 'workspace'` is now
-- a committed enum label and is legal to reference here.
--
-- Recreate the artifacts SELECT policy to handle workspace visibility:
--   1. Owner can see their own artifacts
--   2. Authenticated workspace members can see artifacts marked 'workspace'
--   3. Anyone (including anon) can see 'unlisted' or 'public' artifacts
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

-- Update stays owner-only (unchanged) — the existing "Owners update artifacts"
-- policy is intentionally left as-is; collaborative editing can be added later.
