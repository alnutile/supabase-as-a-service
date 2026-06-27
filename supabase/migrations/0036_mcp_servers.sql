-- Multiple external MCP servers (Phase 1: workspace-wide).
--
-- 0032 shipped a SINGLE workspace MCP endpoint crammed into `integrations`
-- (kind='mcp', unique). This generalizes it to MANY servers via a dedicated
-- `mcp_servers` table — connect Zapier AND an email-MCP AND a calendar one, each
-- with its own Vault token, each independently activatable and agent-scopable.
--
-- Each server still gets ONE `tools` row of kind='mcp' as its in-app handle
-- (tools.config.server_id → mcp_servers.id), so activation (is_active) and agent
-- `tool_ids` scoping keep working per-server. The discovered toolset is cached on
-- `mcp_servers.cached_tools` so the loops don't re-handshake every message.
--
-- The `owner_id` + `scope` columns are present but unused in Phase 1 (every row
-- is workspace/admin-managed); Phase 2 (per-user servers) fills them in.

create table public.mcp_servers (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  url text not null,
  secret_id uuid not null,                 -- vault.secrets.id holding the bearer token
  owner_id uuid references auth.users (id) on delete cascade,  -- null = workspace-wide
  scope text not null default 'workspace' check (scope in ('workspace', 'private')),
  tool_id uuid references public.tools (id) on delete set null, -- the kind='mcp' handle
  cached_tools jsonb not null default '[]'::jsonb,
  cached_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mcp_servers enable row level security;

-- Admins read all; a user reads their own (Phase 2). Writes go only through the
-- security-definer RPCs below, so there are no client insert/update/delete policies.
create policy "Read mcp servers"
  on public.mcp_servers for select
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Admin-gated upsert. p_id null → create (new Vault secret + a kind='mcp' tools
-- handle); else update (token write-only: empty keeps the existing secret).
-- Returns the server id.
create or replace function public.set_mcp_server(
  p_id uuid,
  p_label text,
  p_url text,
  p_token text
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_is_admin boolean;
  v_existing public.mcp_servers;
  v_secret_id uuid;
  v_name text;
  v_tool_id uuid;
  v_id uuid;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can configure an MCP server';
  end if;
  if coalesce(trim(p_url), '') = '' then
    raise exception 'An MCP endpoint URL is required';
  end if;

  -- snake_case, OpenAI-function-name-safe prefix derived from the label.
  v_name := regexp_replace(lower(coalesce(nullif(trim(p_label), ''), 'mcp')), '[^a-z0-9]+', '_', 'g');
  v_name := trim(both '_' from v_name);
  if v_name = '' then v_name := 'mcp'; end if;

  if p_id is null then
    if coalesce(trim(p_token), '') = '' then
      raise exception 'A bearer token is required to add an MCP server';
    end if;
    v_secret_id := vault.create_secret(
      p_token,
      'mcp_token_' || replace(gen_random_uuid()::text, '-', ''),
      'MCP server bearer token (' || v_name || ')'
    );
    insert into public.mcp_servers (label, url, secret_id, scope)
    values (coalesce(nullif(trim(p_label), ''), v_name), trim(p_url), v_secret_id, 'workspace')
    returning id into v_id;

    insert into public.tools (name, description, kind, config, is_active, is_builtin, created_by)
    values (
      v_name,
      'External MCP server "' || coalesce(nullif(trim(p_label), ''), v_name) || '" — exposes its remote tools to agents.',
      'mcp',
      jsonb_build_object('url', trim(p_url), 'server_id', v_id),
      true, false, auth.uid()
    )
    returning id into v_tool_id;

    update public.mcp_servers set tool_id = v_tool_id where id = v_id;
    return v_id;
  end if;

  select * into v_existing from public.mcp_servers where id = p_id;
  if v_existing.id is null then
    raise exception 'MCP server not found';
  end if;
  if coalesce(trim(p_token), '') <> '' then
    perform vault.update_secret(v_existing.secret_id, p_token);
  end if;
  update public.mcp_servers
    set label = coalesce(nullif(trim(p_label), ''), v_name),
        url = trim(p_url),
        cached_tools = '[]'::jsonb,           -- force a re-discover against the new url/token
        cached_at = null,
        updated_at = now()
    where id = p_id;
  if v_existing.tool_id is not null then
    update public.tools
      set name = v_name,
          config = jsonb_build_object('url', trim(p_url), 'server_id', p_id),
          updated_at = now()
      where id = v_existing.tool_id;
  end if;
  return p_id;
end;
$$;
revoke execute on function public.set_mcp_server(uuid, text, text, text) from anon, public;
grant execute on function public.set_mcp_server(uuid, text, text, text) to authenticated;

-- Admin-gated delete: drops the handle tools row and the server row.
create or replace function public.delete_mcp_server(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_is_admin boolean;
  v_tool_id uuid;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can remove an MCP server';
  end if;
  select tool_id into v_tool_id from public.mcp_servers where id = p_id;
  delete from public.mcp_servers where id = p_id;
  if v_tool_id is not null then
    delete from public.tools where id = v_tool_id;
  end if;
end;
$$;
revoke execute on function public.delete_mcp_server(uuid) from anon, public;
grant execute on function public.delete_mcp_server(uuid) to authenticated;

-- Service-role-only reader of a specific server's decrypted token (edge functions
-- call this). Replaces the no-arg 0032 reader.
create or replace function public.read_mcp_secret(p_server_id uuid)
returns text language sql stable security definer set search_path = public, vault as $$
  select s.decrypted_secret
  from public.mcp_servers i
  join vault.decrypted_secrets s on s.id = i.secret_id
  where i.id = p_server_id;
$$;
revoke execute on function public.read_mcp_secret(uuid) from anon, authenticated, public;

-- Migrate the single 0032 integration (if present) into mcp_servers, relinking
-- its existing kind='mcp' tools handle, then drop the old row + functions.
do $$
declare
  v_integ public.integrations;
  v_tool public.tools;
  v_id uuid;
begin
  select * into v_integ from public.integrations where kind = 'mcp';
  if v_integ.id is not null then
    insert into public.mcp_servers (label, url, secret_id, scope)
    values (
      coalesce(v_integ.config->>'label', 'zapier'),
      coalesce(v_integ.config->>'url', ''),
      v_integ.secret_id,
      'workspace'
    )
    returning id into v_id;

    select * into v_tool from public.tools where kind = 'mcp' limit 1;
    if v_tool.id is not null then
      update public.mcp_servers
        set tool_id = v_tool.id,
            cached_tools = coalesce(v_tool.config->'tools', '[]'::jsonb),
            cached_at = nullif(v_tool.config->>'cached_at', '')::timestamptz
        where id = v_id;
      update public.tools
        set config = jsonb_build_object('url', coalesce(v_integ.config->>'url', ''), 'server_id', v_id)
        where id = v_tool.id;
    end if;

    delete from public.integrations where id = v_integ.id;
  end if;
end $$;

drop function if exists public.set_mcp_integration(text, text, text);
drop function if exists public.read_mcp_secret();
drop function if exists public.mcp_is_configured();
