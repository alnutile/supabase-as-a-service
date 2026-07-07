-- 0062 artifact share password
-- ---------------------------------------------------------------------------
-- Optional password on a SHARED (unlisted/public) artifact, so an owner can
-- hand a customer a link + a password and only someone with both can read it.
--
-- Security model: the password is not "secret-URL" theater — a client-side
-- check would be pointless because the artifact row (with its content) is
-- readable by anon over RLS. So we HIDE the whole row from non-owners once a
-- password is set: the read policy below only exposes shared rows whose
-- `share_password_hash` IS NULL. A password-protected artifact reaches viewers
-- ONLY through the security-definer `get_shared_artifact()` RPC, which returns
-- the content just when the supplied password matches the stored bcrypt hash.
-- The hash itself is never returned to a client (the RPC selects an explicit
-- column list that omits it), and the plaintext never lands in a table column
-- (the owner sets it through `set_artifact_password()`, which hashes server-side).
--
-- pgcrypto (bcrypt via crypt()/gen_salt('bf')) is used for the hash; on Supabase
-- it lives in the `extensions` schema.
create extension if not exists pgcrypto with schema extensions;

alter table public.artifacts
  add column if not exists share_password_hash text;

-- Replace the anon-read policy: a shared artifact stays readable by anyone with
-- the link ONLY while it has no share password; once one is set the row is
-- hidden from everyone but the owner (viewers go through get_shared_artifact).
drop policy if exists "Read own or shared artifacts" on public.artifacts;
create policy "Read own or shared artifacts"
  on public.artifacts for select
  using (
    owner_id = auth.uid()
    or (visibility <> 'private' and share_password_hash is null)
  );

-- Owner sets or clears the share password. An empty/whitespace value clears it
-- (back to open-link sharing). Hashed with bcrypt; only the owner may call it.
create or replace function public.set_artifact_password(p_id uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_owner uuid;
begin
  select owner_id into v_owner from public.artifacts where id = p_id;
  if v_owner is null then
    raise exception 'Artifact not found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'Only the owner can set a share password';
  end if;

  update public.artifacts
    set share_password_hash = case
      when p_password is null or length(trim(p_password)) = 0 then null
      else extensions.crypt(p_password, extensions.gen_salt('bf'))
    end
    where id = p_id;
end;
$$;

-- Public: existence + password requirement for a shared artifact by slug.
-- Leaks only whether the link is valid and whether a password is needed — never
-- the title, content, or hash — so the viewer page can decide to show the gate.
create or replace function public.artifact_share_meta(p_slug text)
returns table (found boolean, requires_password boolean)
language sql
stable
security definer
set search_path = public
as $$
  select true, (a.share_password_hash is not null)
  from public.artifacts a
  where a.public_slug = p_slug and a.visibility <> 'private'
  limit 1;
$$;

-- Public: fetch a shared artifact, enforcing the password when one is set.
-- Returns the row (WITHOUT the hash) only when the artifact is shared and the
-- password is absent or correct; a wrong/missing password yields zero rows,
-- indistinguishable from not-found.
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
    and (
      a.share_password_hash is null
      or (p_password is not null and a.share_password_hash = extensions.crypt(p_password, a.share_password_hash))
    )
  limit 1;
$$;

grant execute on function public.artifact_share_meta(text) to anon, authenticated;
grant execute on function public.get_shared_artifact(text, text) to anon, authenticated;
grant execute on function public.set_artifact_password(uuid, text) to authenticated;
