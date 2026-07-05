-- Slack bot: rooms bound to collections (Claude-Tag-style contextual bot).
--
-- A Slack app is invited into channels; when someone @mentions the bot, the
-- public `slack-events` edge function answers using the channel's BINDING — a
-- row that says "this channel = these collections (+ optionally this agent)".
-- The reply runs the same agent loop as webhooks (collections context,
-- guardrails, optional tools) and is posted back into the Slack thread.
--
-- Credentials follow the email/MCP pattern: the bot token and signing secret
-- live ONLY in Supabase Vault. The non-secret config sits in
-- `public.slack_integration` with `secret_id` pointers; the client writes them
-- solely through the admin-gated security-definer RPC `set_slack_integration`,
-- and edge functions read the decrypted values through the service-role-only
-- `read_slack_secrets`. No secret is ever a table column or client payload.

-- ---------------------------------------------------------------------------
-- Workspace Slack config (single row).
create table public.slack_integration (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),
  team_name text,                          -- cosmetic label for the Settings UI
  bot_user_id text,                        -- Slack bot user id (U…); learned from the first event, used to strip self-mentions
  bot_token_secret_id uuid not null,       -- vault.secrets.id → xoxb- bot token
  signing_secret_id uuid not null,         -- vault.secrets.id → app signing secret
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.slack_integration enable row level security;

-- Only admins read the row (team name / configured-ness) for Settings. Writes
-- never come from clients — they go through the RPCs below.
create policy "Admins read slack integration"
  on public.slack_integration for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Members only need "is Slack set up?" as a boolean.
create or replace function public.slack_is_configured()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.slack_integration);
$$;
revoke execute on function public.slack_is_configured() from public, anon;
grant execute on function public.slack_is_configured() to authenticated;

-- Admin-gated writer. Both secrets are write-only: empty/null on update keeps
-- the existing Vault value. Admin-checked INSIDE the body (UI gating is cosmetic).
create or replace function public.set_slack_integration(
  p_bot_token text,
  p_signing_secret text,
  p_team_name text default null
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_is_admin boolean;
  v_existing public.slack_integration;
  v_bot_secret_id uuid;
  v_signing_secret_id uuid;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can configure Slack';
  end if;

  select * into v_existing from public.slack_integration;

  if v_existing.id is null then
    if coalesce(trim(p_bot_token), '') = '' or coalesce(trim(p_signing_secret), '') = '' then
      raise exception 'A bot token and signing secret are required to set up Slack';
    end if;
    v_bot_secret_id := vault.create_secret(
      trim(p_bot_token),
      'slack_bot_token_' || replace(gen_random_uuid()::text, '-', ''),
      'Slack bot token (workspace Slack integration)'
    );
    v_signing_secret_id := vault.create_secret(
      trim(p_signing_secret),
      'slack_signing_secret_' || replace(gen_random_uuid()::text, '-', ''),
      'Slack signing secret (workspace Slack integration)'
    );
    insert into public.slack_integration (team_name, bot_token_secret_id, signing_secret_id)
    values (nullif(trim(coalesce(p_team_name, '')), ''), v_bot_secret_id, v_signing_secret_id);
  else
    if coalesce(trim(p_bot_token), '') <> '' then
      perform vault.update_secret(v_existing.bot_token_secret_id, trim(p_bot_token));
    end if;
    if coalesce(trim(p_signing_secret), '') <> '' then
      perform vault.update_secret(v_existing.signing_secret_id, trim(p_signing_secret));
    end if;
    update public.slack_integration
      set team_name = nullif(trim(coalesce(p_team_name, '')), ''),
          updated_at = now()
      where id = v_existing.id;
  end if;
end;
$$;
revoke execute on function public.set_slack_integration(text, text, text) from anon, public;
grant execute on function public.set_slack_integration(text, text, text) to authenticated;

-- Admin-gated removal (bindings stay; they're inert without credentials).
create or replace function public.delete_slack_integration()
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_is_admin boolean;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can remove the Slack integration';
  end if;
  delete from public.slack_integration;
end;
$$;
revoke execute on function public.delete_slack_integration() from anon, public;
grant execute on function public.delete_slack_integration() to authenticated;

-- Service-role-only reader of the decrypted secrets (the slack-events function
-- calls this). Execute revoked from API roles, mirroring read_email_secret.
create or replace function public.read_slack_secrets()
returns table (bot_token text, signing_secret text, bot_user_id text)
language sql stable security definer set search_path = public, vault as $$
  select bs.decrypted_secret, ss.decrypted_secret, i.bot_user_id
  from public.slack_integration i
  join vault.decrypted_secrets bs on bs.id = i.bot_token_secret_id
  join vault.decrypted_secrets ss on ss.id = i.signing_secret_id;
$$;
revoke execute on function public.read_slack_secrets() from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Channel bindings: "this Slack channel = these collections (+ this agent)".
-- The binding's creator is the identity the bot RUNS AS (like webhooks.owner_id):
-- collections context and builtin tools re-enforce that user's access in code,
-- so bind workspace-visibility collections for team rooms.
create table public.slack_channel_bindings (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null unique,         -- Slack channel id (C…/G…)
  channel_name text not null default '',   -- cosmetic (#project-acme)
  collection_ids uuid[] not null default '{}',
  agent_id uuid references public.agents (id) on delete set null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  allow_tools boolean not null default false,  -- deterministic gate, like webhooks.allow_tools
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.slack_channel_bindings enable row level security;

-- Every member can see which channels are bound (workspace-shared surface);
-- only admins manage bindings, and a new binding runs as its creator.
create policy "Members read slack bindings"
  on public.slack_channel_bindings for select
  using (auth.role() = 'authenticated');
create policy "Admins insert slack bindings"
  on public.slack_channel_bindings for insert
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
create policy "Admins update slack bindings"
  on public.slack_channel_bindings for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
create policy "Admins delete slack bindings"
  on public.slack_channel_bindings for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ---------------------------------------------------------------------------
-- Event log + dedupe. Slack redelivers on any slow ack or non-2xx, so the
-- unique event_id is the idempotency key; rows double as a live audit log
-- ("who asked what, in which channel, and what happened").
create table public.slack_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,           -- Slack's event_id
  channel_id text,
  slack_user_id text,                      -- who @mentioned the bot
  kind text not null default 'app_mention',
  status text not null default 'received' check (status in ('received', 'ok', 'error', 'blocked', 'skipped')),
  text text,                               -- the (mention-stripped) request
  result text,                             -- the bot's reply
  error text,
  created_at timestamptz not null default now()
);
create index slack_events_created_idx on public.slack_events (created_at desc);

alter table public.slack_events enable row level security;

-- Admins read the log; only the edge function (service role) writes.
create policy "Admins read slack events"
  on public.slack_events for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
