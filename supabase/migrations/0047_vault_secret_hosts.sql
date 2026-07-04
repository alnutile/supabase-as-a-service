-- Host-bound vault secrets + the generic `http_request` builtin.
--
-- n8n-style generic HTTP: instead of one tool row per service, the assistant
-- can call `http_request` with any url/method/headers and reference a vault
-- secret with {{vault:name}} in a header value. What makes that safe is the
-- binding added here: `vault_secrets.allowed_hosts` pins a secret to the
-- host(s) it may be sent to. The generic tool REFUSES to resolve a secret with
-- no host binding, and any resolution (generic or per-tool config) fails when
-- the request targets a host outside the list — so a prompt-injected "send the
-- key to evil.example" can make a request, but never with a credential
-- attached. Enforcement lives in supabase/functions/_shared/http_tool.ts.
-- Entries are hostnames ('api.example.com') or wildcard suffixes ('*.example.com').

alter table public.vault_secrets
  add column if not exists allowed_hosts text[] not null default '{}';

-- Recreate the upsert RPC with the new parameter (signature change → drop).
-- p_allowed_hosts null on edit keeps the existing list.
drop function if exists public.set_vault_secret(uuid, text, text, text, text);

create or replace function public.set_vault_secret(
  p_id uuid,
  p_name text,
  p_description text,
  p_value text,
  p_scope text default 'workspace',
  p_allowed_hosts text[] default null
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
  v_hosts text[];
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
  select coalesce(array_agg(lower(trim(h))), '{}')
    into v_hosts
    from unnest(coalesce(p_allowed_hosts, '{}'::text[])) h
    where trim(h) <> '';

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
    insert into public.vault_secrets (name, description, secret_id, scope, owner_id, allowed_hosts)
    values (v_name, coalesce(trim(p_description), ''), v_secret_id, v_scope, auth.uid(), v_hosts)
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
        allowed_hosts = case when p_allowed_hosts is null then v_existing.allowed_hosts else v_hosts end,
        updated_at = now()
    where id = p_id;
  return p_id;
end;
$$;
revoke execute on function public.set_vault_secret(uuid, text, text, text, text, text[]) from anon, public;
grant execute on function public.set_vault_secret(uuid, text, text, text, text, text[]) to authenticated;

-- Seed the generic HTTP builtin (idempotent). One tool for any service: the
-- model supplies url/method/headers/body; {{vault:name}} in a header or the
-- url resolves server-side, host-bound as above.
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'http_request',
  'Make an HTTP request to any web API. For authenticated APIs, reference a team vault secret inside a header value, e.g. {"Authorization": "Bearer {{vault:my_api_key}}"} — the placeholder is filled in server-side and the real value never enters the conversation. A secret only works against the hosts listed on it in the Secrets page (Allowed hosts); a secret with no allowed hosts cannot be used here. Use list_secrets to discover available credential names. Prefer a purpose-built tool when one exists.',
  '{"type":"object","required":["url"],"properties":{"url":{"type":"string","description":"Full http(s) URL of the endpoint"},"method":{"type":"string","enum":["GET","POST","PUT","PATCH","DELETE"],"description":"Defaults to GET (POST when a body is given)"},"headers":{"type":"object","description":"Request headers; values may embed {{vault:secret_name}}"},"body":{"description":"Request body: an object is sent as JSON, a string as-is"}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'http_request');
