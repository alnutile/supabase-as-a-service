-- External MCP server as a workspace capability: connect one MCP endpoint
-- (e.g. Zapier MCP in front of Gmail / Calendar / …) once, and every agent loop
-- (chat, scheduler, webhook) can call the tools it exposes — discovered
-- automatically via the MCP `tools/list` handshake, no per-tool hand-authoring.
--
-- Same trust model as the email integration (0016): the bearer token lives ONLY
-- in Supabase Vault. The non-secret config (endpoint URL + label) sits on
-- `public.integrations` (kind = 'mcp') with a `secret_id` pointer; the client
-- writes the token solely through the admin-gated, security-definer RPC
-- `set_mcp_integration`; edge functions read it through the service-role-only
-- `read_mcp_secret`. The token is never a table column, never in a client
-- payload, never in a tool's `config`.
--
-- A single `tools` row of `kind = 'mcp'` is the in-app handle for the whole
-- connection: activating/deactivating it or scoping it to an agent (via
-- `tool_ids`) turns the entire remote toolset on/off, exactly like any other
-- tool. The discovered tool list is cached on that row's `config.tools` so the
-- loops don't re-handshake every message.

-- 0016 created `integrations` with `kind` unique + check (kind in ('email')) and
-- NOT NULL email columns. Widen it to also hold an 'mcp' row.
alter table public.integrations drop constraint if exists integrations_kind_check;
alter table public.integrations add constraint integrations_kind_check check (kind in ('email', 'mcp'));

-- Email-specific columns must be nullable so an 'mcp' row can omit them (a check
-- constraint passes on NULL, so the existing provider check is unaffected).
alter table public.integrations alter column provider drop not null;
alter table public.integrations alter column from_address drop not null;

-- Non-secret config for non-email integrations: { url, label } for mcp.
alter table public.integrations add column if not exists config jsonb not null default '{}'::jsonb;

-- Admin-gated writer (admin-checked INSIDE the body; UI gating is cosmetic).
-- Creates/updates the Vault secret holding the bearer token and upserts BOTH the
-- integrations row and the single `kind='mcp'` tools handle. The token is
-- write-only: an empty/null token on update keeps the existing secret. Never
-- returns the token.
create or replace function public.set_mcp_integration(
  p_url text,
  p_token text,
  p_label text default 'zapier'
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
  v_name text;
  v_tool_id uuid;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can configure an MCP server';
  end if;
  if coalesce(trim(p_url), '') = '' then
    raise exception 'An MCP endpoint URL is required';
  end if;

  -- snake_case, safe-for-OpenAI-function-name prefix derived from the label.
  v_name := regexp_replace(lower(coalesce(nullif(trim(p_label), ''), 'mcp')), '[^a-z0-9]+', '_', 'g');
  v_name := trim(both '_' from v_name);
  if v_name = '' then v_name := 'mcp'; end if;

  select * into v_existing from public.integrations where kind = 'mcp';

  if v_existing.id is null then
    if coalesce(trim(p_token), '') = '' then
      raise exception 'A bearer token is required to set up the MCP server';
    end if;
    v_secret_id := vault.create_secret(
      p_token,
      'mcp_token_' || replace(gen_random_uuid()::text, '-', ''),
      'MCP server bearer token (workspace MCP integration)'
    );
    insert into public.integrations (kind, secret_id, config)
    values ('mcp', v_secret_id, jsonb_build_object('url', trim(p_url), 'label', coalesce(nullif(trim(p_label), ''), v_name)));
  else
    if coalesce(trim(p_token), '') <> '' then
      perform vault.update_secret(v_existing.secret_id, p_token);
    end if;
    update public.integrations
      set config = jsonb_build_object('url', trim(p_url), 'label', coalesce(nullif(trim(p_label), ''), v_name)),
          updated_at = now()
      where kind = 'mcp';
  end if;

  -- Upsert the single tools handle. Reset the cache so the next run re-discovers
  -- against the (possibly new) URL/token.
  select id into v_tool_id from public.tools where kind = 'mcp' limit 1;
  if v_tool_id is null then
    insert into public.tools (name, description, kind, config, is_active, is_builtin, created_by)
    values (
      v_name,
      'External MCP server — exposes its remote tools (e.g. Gmail, Calendar) to agents.',
      'mcp',
      jsonb_build_object('url', trim(p_url)),
      true, false, auth.uid()
    );
  else
    update public.tools
      set name = v_name,
          config = jsonb_build_object('url', trim(p_url)),
          updated_at = now()
      where id = v_tool_id;
  end if;
end;
$$;
revoke execute on function public.set_mcp_integration(text, text, text) from anon, public;
grant execute on function public.set_mcp_integration(text, text, text) to authenticated;

-- Service-role-only reader of the decrypted token (edge functions call this).
-- Execute revoked from API roles so clients can never read the token.
create or replace function public.read_mcp_secret()
returns text language sql stable security definer set search_path = public, vault as $$
  select s.decrypted_secret
  from public.integrations i
  join vault.decrypted_secrets s on s.id = i.secret_id
  where i.kind = 'mcp';
$$;
revoke execute on function public.read_mcp_secret() from anon, authenticated, public;

-- Non-admins only need to know whether an MCP server exists; expose a boolean.
create or replace function public.mcp_is_configured()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.integrations where kind = 'mcp');
$$;
revoke execute on function public.mcp_is_configured() from public, anon;
grant execute on function public.mcp_is_configured() to authenticated;
