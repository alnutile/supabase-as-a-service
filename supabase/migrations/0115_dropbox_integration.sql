-- Dropbox integration for enhanced link metadata and file ingestion.
--
-- An admin configures a personal Dropbox access token in Settings → Dropbox.
-- When a user saves a Dropbox link, the system:
--  1. Detects it's a Dropbox URL
--  2. Uses the saved token to fetch rich metadata (file name, thumbnail, etc.)
--  3. Optionally allows ingesting the file as an artifact
--
-- Credentials live ONLY in Supabase Vault. The config sits in
-- `public.integrations` with a pointer (`secret_id`) to the Vault secret.
-- Clients write the token exclusively through the admin-gated, security-definer
-- RPC `set_dropbox_integration`; edge functions read the decrypted token through
-- the service-role-only `read_dropbox_secret`. No secret value is ever readable
-- through PostgREST or returned to the UI.

-- Extend integrations table to include 'dropbox' kind
alter table public.integrations drop constraint if exists integrations_kind_check;
alter table public.integrations add constraint integrations_kind_check
  check (kind in ('email', 'dropbox'));

-- Admin-gated writer for Dropbox integration. Admin-checked INSIDE the body.
-- Creates/updates the Vault secret and upserts the integrations row.
-- The access token is write-only: an empty/null token on update keeps the
-- existing secret. Never returns the token.
create or replace function public.set_dropbox_integration(
  p_access_token text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_is_admin boolean;
  v_existing public.integrations;
  v_secret_id uuid;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can configure Dropbox';
  end if;
  if coalesce(trim(p_access_token), '') = '' then
    raise exception 'An access token is required';
  end if;

  select * into v_existing from public.integrations where kind = 'dropbox';

  if v_existing.id is null then
    v_secret_id := vault.create_secret(
      p_access_token,
      'dropbox_access_token_' || replace(gen_random_uuid()::text, '-', ''),
      'Dropbox access token (workspace Dropbox integration)'
    );
    insert into public.integrations (kind, provider, from_address, secret_id)
    values ('dropbox', 'dropbox', '', v_secret_id);
  else
    perform vault.update_secret(v_existing.secret_id, p_access_token);
    update public.integrations
      set updated_at = now()
      where kind = 'dropbox';
  end if;
end;
$$;
revoke execute on function public.set_dropbox_integration(text) from anon, public;
grant execute on function public.set_dropbox_integration(text) to authenticated;

-- Service-role-only reader of the decrypted token (edge functions call this).
-- The security-definer body runs as the owner, which can read vault.decrypted_secrets;
-- execute is revoked from API roles so clients can never call it.
create or replace function public.read_dropbox_secret()
returns text language sql stable security definer set search_path = public, vault as $$
  select s.decrypted_secret
  from public.integrations i
  join vault.decrypted_secrets s on s.id = i.secret_id
  where i.kind = 'dropbox';
$$;
revoke execute on function public.read_dropbox_secret() from anon, authenticated, public;

-- Helper to check if Dropbox is configured (non-admins need to know whether
-- it's available without seeing the actual config).
create or replace function public.dropbox_is_configured()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.integrations where kind = 'dropbox');
$$;
revoke execute on function public.dropbox_is_configured() from public, anon;
grant execute on function public.dropbox_is_configured() to authenticated;

-- Delete Dropbox integration (admin-only).
create or replace function public.delete_dropbox_integration()
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_is_admin boolean;
  v_existing public.integrations;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can delete Dropbox integration';
  end if;

  select * into v_existing from public.integrations where kind = 'dropbox';

  if v_existing.id is not null then
    -- Delete the vault secret first
    perform vault.delete_secret(v_existing.secret_id);
    -- Then delete the integration row
    delete from public.integrations where kind = 'dropbox';
  end if;
end;
$$;
revoke execute on function public.delete_dropbox_integration() from anon, public;
grant execute on function public.delete_dropbox_integration() to authenticated;
