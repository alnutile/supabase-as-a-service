-- Restore the share-password gate that 0098 dropped.
--
-- The password-on-a-shared-artifact feature (0062) hides a protected row from
-- everyone but the owner over RLS: viewers only reach it through the
-- security-definer `get_shared_artifact()` RPC, which checks the bcrypt hash.
-- That protection depended on the SELECT policy exposing shared rows ONLY when
-- `share_password_hash is null`.
--
-- When 0098 added 'workspace' visibility it recreated the SELECT policy with a
-- bare `visibility in ('unlisted','public')` branch and NO password check — so a
-- password-protected artifact became readable directly over RLS by anyone,
-- including anon, completely bypassing the gate.
--
-- Recreate the policy with the guard back on the external-sharing branch. The
-- password gate only applies to external (unlisted/public) links, so the
-- 'workspace' (authenticated members) branch is unaffected.
drop policy if exists "Read own or shared artifacts" on public.artifacts;
create policy "Read own or shared artifacts"
  on public.artifacts for select
  using (
    owner_id = auth.uid()
    or (visibility = 'workspace' and auth.role() = 'authenticated')
    or (visibility in ('unlisted', 'public') and share_password_hash is null)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
