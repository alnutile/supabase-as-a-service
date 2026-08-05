-- 0111_mcp_client_oauth.sql
-- Outbound OAuth for the External MCP feature: connect the workspace (acting as an
-- MCP *client*) to OAuth-protected MCP endpoints (Notion, Linear, GitHub,
-- Atlassian, …) via the OAuth 2.1 + PKCE authorization-code flow with Dynamic
-- Client Registration — not just a static bearer token. This is the client mirror
-- of the inbound authorization server shipped in 0077_mcp_oauth.sql.
--
-- Trust boundary is unchanged — every credential lives ONLY in Supabase Vault:
--   mcp_servers.secret_id          → the OAuth *access* token (reuses the bearer
--                                     column, so read_mcp_secret / the mcp.ts call
--                                     path work for both auth kinds). Now nullable
--                                     because an OAuth server has no token until it
--                                     is connected.
--   mcp_servers.refresh_secret_id  → the OAuth *refresh* token (rotate on refresh)
--   mcp_servers.client_secret_id   → optional OAuth client secret (confidential
--                                     clients; DCR public clients have none)
--   mcp_servers.oauth (jsonb)      → NON-secret metadata: authorization_endpoint,
--                                     token_endpoint, registration_endpoint,
--                                     client_id, redirect_uri, scope, resource,
--                                     status, expires_at, connected_at
--   mcp_servers.auth_type          → 'bearer' (default, unchanged) | 'oauth'

alter table public.mcp_servers alter column secret_id drop not null;
alter table public.mcp_servers
  add column if not exists auth_type text not null default 'bearer'
    check (auth_type in ('bearer', 'oauth'));
alter table public.mcp_servers add column if not exists oauth jsonb not null default '{}'::jsonb;
alter table public.mcp_servers add column if not exists refresh_secret_id uuid;
alter table public.mcp_servers add column if not exists client_secret_id uuid;

-- Pending authorization-code flows: state → PKCE verifier + the endpoints the
-- callback needs to exchange the code. Written/read ONLY by the edge functions
-- (service role); single-use + short TTL. No API-role policies (mirrors
-- oauth_authorization_codes in 0077).
create table if not exists public.mcp_oauth_states (
  state text primary key,
  server_id uuid not null references public.mcp_servers (id) on delete cascade,
  code_verifier text not null,
  redirect_uri text not null,
  authorization_endpoint text not null,
  token_endpoint text not null,
  client_id text not null,
  scope text,
  resource text,
  return_to text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists mcp_oauth_states_expires_idx on public.mcp_oauth_states (expires_at);

alter table public.mcp_oauth_states enable row level security;

-- Service-role-only reader of an OAuth server's decrypted secrets + metadata.
-- Edge functions (mcp.ts refresh, mcp-connect, mcp-oauth-callback) call this; it
-- is never reachable from the browser.
create or replace function public.read_mcp_oauth(p_server_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, vault
as $$
  select jsonb_build_object(
    'auth_type', i.auth_type,
    'oauth', i.oauth,
    'access_token', (select s.decrypted_secret from vault.decrypted_secrets s where s.id = i.secret_id),
    'refresh_token', (select s.decrypted_secret from vault.decrypted_secrets s where s.id = i.refresh_secret_id),
    'client_secret', (select s.decrypted_secret from vault.decrypted_secrets s where s.id = i.client_secret_id)
  )
  from public.mcp_servers i
  where i.id = p_server_id;
$$;
revoke execute on function public.read_mcp_oauth(uuid) from anon, authenticated, public;

-- Store the discovered OAuth config (endpoints/client_id/redirect_uri/scope/…) as
-- non-secret metadata, and the optional client secret into Vault. Called by
-- mcp-connect once discovery + DCR resolve. Merges into oauth so partial updates
-- are safe. Service-role only.
create or replace function public.save_mcp_oauth_config(
  p_server_id uuid,
  p_oauth jsonb,
  p_client_secret text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing public.mcp_servers;
  v_cs_id uuid;
begin
  select * into v_existing from public.mcp_servers where id = p_server_id;
  if v_existing.id is null then
    raise exception 'MCP server not found';
  end if;
  update public.mcp_servers
    set oauth = coalesce(oauth, '{}'::jsonb) || coalesce(p_oauth, '{}'::jsonb),
        auth_type = 'oauth',
        updated_at = now()
    where id = p_server_id;
  if coalesce(trim(p_client_secret), '') <> '' then
    if v_existing.client_secret_id is null then
      v_cs_id := vault.create_secret(
        p_client_secret,
        'mcp_client_secret_' || replace(gen_random_uuid()::text, '-', ''),
        'MCP OAuth client secret'
      );
      update public.mcp_servers set client_secret_id = v_cs_id where id = p_server_id;
    else
      perform vault.update_secret(v_existing.client_secret_id, p_client_secret);
    end if;
  end if;
end;
$$;
revoke execute on function public.save_mcp_oauth_config(uuid, jsonb, text) from anon, authenticated, public;

-- Persist freshly-minted (or refreshed) OAuth tokens into Vault + mark the server
-- connected. Access token reuses secret_id (created on first connect); refresh
-- token rotates in refresh_secret_id (only overwritten when the server returns a
-- new one). Clears the tool cache so the next run re-discovers with the new token.
-- p_expires_at is an ISO 8601 string (stored verbatim in the oauth jsonb).
-- Service-role only.
create or replace function public.save_mcp_oauth_tokens(
  p_server_id uuid,
  p_access text,
  p_refresh text,
  p_expires_at text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing public.mcp_servers;
  v_sid uuid;
  v_rid uuid;
begin
  select * into v_existing from public.mcp_servers where id = p_server_id;
  if v_existing.id is null then
    raise exception 'MCP server not found';
  end if;

  if coalesce(trim(p_access), '') <> '' then
    if v_existing.secret_id is null then
      v_sid := vault.create_secret(
        p_access,
        'mcp_access_' || replace(gen_random_uuid()::text, '-', ''),
        'MCP OAuth access token'
      );
      update public.mcp_servers set secret_id = v_sid where id = p_server_id;
    else
      perform vault.update_secret(v_existing.secret_id, p_access);
    end if;
  end if;

  if coalesce(trim(p_refresh), '') <> '' then
    if v_existing.refresh_secret_id is null then
      v_rid := vault.create_secret(
        p_refresh,
        'mcp_refresh_' || replace(gen_random_uuid()::text, '-', ''),
        'MCP OAuth refresh token'
      );
      update public.mcp_servers set refresh_secret_id = v_rid where id = p_server_id;
    else
      perform vault.update_secret(v_existing.refresh_secret_id, p_refresh);
    end if;
  end if;

  update public.mcp_servers
    set oauth = coalesce(oauth, '{}'::jsonb) || jsonb_build_object(
          'status', 'connected',
          'expires_at', nullif(trim(coalesce(p_expires_at, '')), ''),
          'connected_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ),
        cached_tools = '[]'::jsonb,
        cached_at = null,
        updated_at = now()
    where id = p_server_id;
end;
$$;
revoke execute on function public.save_mcp_oauth_tokens(uuid, text, text, text) from anon, authenticated, public;
