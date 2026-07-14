-- 0077_mcp_oauth.sql
-- OAuth 2.1 (PKCE) authorization-server backing tables for the MCP connector, so
-- Claude's "Add custom connector" flow works by pasting the workspace MCP URL and
-- approving — no static-token copy. The authorization server is the `mcp-oauth`
-- edge function; the `mcp` resource server keeps resolving `mcp_tokens.token →
-- owner_id`, so an OAuth-minted access token is just an mcp_tokens row and the
-- existing auth path (and manually-created static tokens) are unchanged.

-- Dynamically-registered OAuth clients (RFC 7591). Public PKCE clients; no secret.
create table if not exists public.oauth_clients (
  client_id text primary key,
  client_name text,
  redirect_uris text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- Short-lived single-use authorization codes (RFC 6749 + PKCE RFC 7636).
create table if not exists public.oauth_authorization_codes (
  code text primary key,
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  resource text,
  scope text,
  used boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists oauth_codes_expires_idx on public.oauth_authorization_codes (expires_at);

-- Extend the existing per-user token table so an OAuth-minted access token is just
-- an mcp_tokens row with an expiry + refresh token + issuing client. All nullable
-- → manually-created static tokens (Settings → Connect Claude) are unaffected
-- (expires_at null = never expires).
alter table public.mcp_tokens add column if not exists expires_at timestamptz;
alter table public.mcp_tokens add column if not exists refresh_token text;
alter table public.mcp_tokens add column if not exists client_id text;

create index if not exists mcp_tokens_refresh_idx on public.mcp_tokens (refresh_token);

alter table public.oauth_clients enable row level security;
alter table public.oauth_authorization_codes enable row level security;

-- The mcp-oauth edge function runs as the service role (bypasses RLS). No API-role
-- policies are granted on the codes table — it is never read from the browser.
-- Admins may inspect registered clients for a future Connections view.
create policy "Admins read oauth clients"
  on public.oauth_clients for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
