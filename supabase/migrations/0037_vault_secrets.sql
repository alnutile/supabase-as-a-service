-- Team secrets vault (Governance).
--
-- A place for admins to store named secrets (API keys, tokens, passwords) that
-- can be SHARED with the team and fetched by the assistant on demand. Same
-- Vault-backed pattern as the email key (0016) and MCP tokens (0036): the secret
-- VALUE lives ONLY in Supabase Vault; this table holds just non-secret metadata
-- (name, description, scope) plus a `secret_id` pointer. The plaintext value is
-- never a table column, never in a client payload, never logged.
--
-- Sharing model mirrors collections / user_tables: a secret is `private`
-- (owner + admins) or `workspace` (every member can fetch it). Writes go ONLY
-- through the admin-gated security-definer RPCs below — there are no client
-- insert/update/delete policies — and the decrypted value is readable ONLY by
-- the service role (edge functions) via `read_vault_secret`.
--
-- The assistant reaches these through two seeded `is_builtin` tools:
-- `list_secrets` (names + descriptions, NO values) and `get_secret` (one value
-- by name). Because they're ordinary `tools` rows, admin activation, agent
-- `tool_ids` scoping, and the `webhooks.allow_tools` gate all apply. `get_secret`
-- returns a raw secret into the conversation, so it carries the same workspace
-- trust as `send_email` and logs every read to `activity_log`.

create extension if not exists supabase_vault;

create table public.vault_secrets (
  id uuid primary key default gen_random_uuid(),
  name text not null,                       -- lookup key the assistant fetches by
  description text not null default '',     -- what it's for / where to use it
  secret_id uuid not null,                  -- vault.secrets.id holding the value
  scope text not null default 'workspace' check (scope in ('workspace', 'private')),
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive unique name so the assistant can fetch by a stable key.
create unique index vault_secrets_name_key on public.vault_secrets (lower(name));

alter table public.vault_secrets enable row level security;

-- A secret's metadata is visible to its owner, to everyone when shared
-- workspace-wide, or to admins. The value is NOT here (it's in Vault), so this
-- only exposes name/description/scope for the management UI. Writes go through
-- the RPCs below — no client insert/update/delete policies.
create policy "Read vault secrets"
  on public.vault_secrets for select
  using (
    scope = 'workspace'
    or owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Admin-gated upsert. p_id null → create (new Vault secret); else update
-- (value write-only: an empty p_value keeps the existing secret). Returns the id.
create or replace function public.set_vault_secret(
  p_id uuid,
  p_name text,
  p_description text,
  p_value text,
  p_scope text default 'workspace'
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_is_admin boolean;
  v_existing public.vault_secrets;
  v_secret_id uuid;
  v_name text;
  v_scope text;
  v_id uuid;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can manage vault secrets';
  end if;

  v_name := trim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'A name is required';
  end if;
  v_scope := lower(coalesce(nullif(trim(p_scope), ''), 'workspace'));
  if v_scope not in ('workspace', 'private') then
    raise exception 'Scope must be workspace or private';
  end if;

  if p_id is null then
    if coalesce(trim(p_value), '') = '' then
      raise exception 'A value is required to create a secret';
    end if;
    if exists (select 1 from public.vault_secrets where lower(name) = lower(v_name)) then
      raise exception 'A secret named "%" already exists', v_name;
    end if;
    v_secret_id := vault.create_secret(
      p_value,
      'vault_secret_' || replace(gen_random_uuid()::text, '-', ''),
      'Team vault secret (' || v_name || ')'
    );
    insert into public.vault_secrets (name, description, secret_id, scope, owner_id)
    values (v_name, coalesce(trim(p_description), ''), v_secret_id, v_scope, auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  select * into v_existing from public.vault_secrets where id = p_id;
  if v_existing.id is null then
    raise exception 'Secret not found';
  end if;
  if lower(v_name) <> lower(v_existing.name)
     and exists (select 1 from public.vault_secrets where lower(name) = lower(v_name)) then
    raise exception 'A secret named "%" already exists', v_name;
  end if;
  if coalesce(trim(p_value), '') <> '' then
    perform vault.update_secret(v_existing.secret_id, p_value);
  end if;
  update public.vault_secrets
    set name = v_name,
        description = coalesce(trim(p_description), ''),
        scope = v_scope,
        updated_at = now()
    where id = p_id;
  return p_id;
end;
$$;
revoke execute on function public.set_vault_secret(uuid, text, text, text, text) from anon, public;
grant execute on function public.set_vault_secret(uuid, text, text, text, text) to authenticated;

-- Admin-gated delete: removes the row and its Vault secret.
create or replace function public.delete_vault_secret(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_is_admin boolean;
  v_secret_id uuid;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can manage vault secrets';
  end if;
  select secret_id into v_secret_id from public.vault_secrets where id = p_id;
  delete from public.vault_secrets where id = p_id;
  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;
revoke execute on function public.delete_vault_secret(uuid) from anon, public;
grant execute on function public.delete_vault_secret(uuid) to authenticated;

-- Service-role-only reader: decrypts a secret by name, enforcing the share rule
-- in code (workspace secrets to anyone; private only to the owner). Edge
-- functions call this on the assistant's behalf with the caller's user id.
create or replace function public.read_vault_secret(p_name text, p_user_id uuid)
returns text language sql stable security definer set search_path = public, vault as $$
  select s.decrypted_secret
  from public.vault_secrets v
  join vault.decrypted_secrets s on s.id = v.secret_id
  where lower(v.name) = lower(trim(p_name))
    and (v.scope = 'workspace' or v.owner_id = p_user_id)
  limit 1;
$$;
revoke execute on function public.read_vault_secret(text, uuid) from anon, authenticated, public;

-- Seed the two assistant-facing builtins (idempotent).
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'list_secrets',
  'List the named secrets available in the team vault (names and descriptions only — never the values). Use this to discover which credentials you can fetch with get_secret.',
  '{"type":"object","properties":{}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'list_secrets');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'get_secret',
  'Fetch a secret value (API key, token, password) from the team vault by its name. Use only when you genuinely need the credential to complete the task; never reveal it to the user unless they ask for that specific secret.',
  '{"type":"object","properties":{"name":{"type":"string","description":"The exact name of the secret in the vault"}},"required":["name"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'get_secret');
