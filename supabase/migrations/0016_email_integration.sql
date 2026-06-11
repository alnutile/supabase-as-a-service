-- Email as a foundational capability: send + check, credentials in Vault.
--
-- An admin configures email once (provider + from-address + API key) in Settings.
-- After that, any user or agent just *uses* it through two seeded builtin tools —
-- `send_email` and `check_email` — without ever touching providers or keys.
--
-- Secrets live ONLY in Supabase Vault. The non-secret config sits in
-- `public.integrations` with a pointer (`secret_id`) to the Vault secret. The
-- client writes the key exclusively through the admin-gated, security-definer
-- RPC `set_email_integration`; edge functions read the decrypted key through the
-- service-role-only `read_email_secret`. No secret value is ever readable through
-- PostgREST or returned to the UI.

create extension if not exists supabase_vault;

-- Non-secret config + pointers to Vault secrets. One workspace email integration
-- in v1 (kind is unique).
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  kind text not null unique check (kind in ('email')),
  provider text not null check (provider in ('postmark', 'resend')),
  from_address text not null,
  inbound_token text unique,             -- opaque token for the inbound endpoint
  allowed_recipients text[],             -- null = anyone; else exact addresses and/or '@domain.com' suffixes
  secret_id uuid not null,               -- vault.secrets.id holding the provider API key
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.integrations enable row level security;

-- Only admins read the row (provider, from-address, inbound token) for the
-- Settings UI. Writes never come from clients — they go through the RPC below
-- (security definer), so there are no client insert/update/delete policies. This
-- keeps `secret_id` and `inbound_token` away from non-admins entirely.
create policy "Admins read integrations"
  on public.integrations for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Non-admins only need to know whether email exists; expose that as a boolean,
-- never the row.
create or replace function public.email_is_configured()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.integrations where kind = 'email');
$$;
-- Revoke the default PUBLIC grant too (anon inherits PUBLIC), then grant only to
-- signed-in users.
revoke execute on function public.email_is_configured() from public, anon;
grant execute on function public.email_is_configured() to authenticated;

-- Admin-gated writer. Admin-checked INSIDE the body (UI gating is cosmetic).
-- Creates/updates the Vault secret and upserts the integrations row, generating
-- the inbound token on first insert. The API key is write-only: an empty/null
-- key on update keeps the existing secret. Never returns the key.
create or replace function public.set_email_integration(
  p_provider text,
  p_from_address text,
  p_api_key text,
  p_allowed_recipients text[] default null
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
  v_token text;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if coalesce(v_is_admin, false) is not true then
    raise exception 'Only admins can configure email';
  end if;
  if p_provider not in ('postmark', 'resend') then
    raise exception 'Unsupported email provider: %', p_provider;
  end if;
  if coalesce(trim(p_from_address), '') = '' then
    raise exception 'A from-address is required';
  end if;

  select * into v_existing from public.integrations where kind = 'email';

  if v_existing.id is null then
    if coalesce(trim(p_api_key), '') = '' then
      raise exception 'An API key is required to set up email';
    end if;
    v_secret_id := vault.create_secret(
      p_api_key,
      'email_api_key_' || replace(gen_random_uuid()::text, '-', ''),
      'Email provider API key (workspace email integration)'
    );
    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into public.integrations (kind, provider, from_address, inbound_token, allowed_recipients, secret_id)
    values ('email', p_provider, p_from_address, v_token, p_allowed_recipients, v_secret_id);
  else
    if coalesce(trim(p_api_key), '') <> '' then
      perform vault.update_secret(v_existing.secret_id, p_api_key);
    end if;
    update public.integrations
      set provider = p_provider,
          from_address = p_from_address,
          allowed_recipients = p_allowed_recipients,
          updated_at = now()
      where kind = 'email';
  end if;
end;
$$;
revoke execute on function public.set_email_integration(text, text, text, text[]) from anon, public;
grant execute on function public.set_email_integration(text, text, text, text[]) to authenticated;

-- Service-role-only reader of the decrypted key (edge functions call this). The
-- security-definer body runs as the owner, which can read vault.decrypted_secrets;
-- execute is revoked from API roles so clients can never call it. Mirrors the
-- match_document_chunks revoke pattern.
create or replace function public.read_email_secret()
returns text language sql stable security definer set search_path = public, vault as $$
  select s.decrypted_secret
  from public.integrations i
  join vault.decrypted_secrets s on s.id = i.secret_id
  where i.kind = 'email';
$$;
revoke execute on function public.read_email_secret() from anon, authenticated, public;

-- Shared workspace inbox. Point a DEDICATED address at the inbound endpoint, not
-- a personal mailbox — every member's agent can read these via check_email.
create table public.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  from_address text not null,
  to_address text,
  subject text not null default '',
  body_text text not null default '',
  received_at timestamptz not null default now(),
  read_at timestamptz,
  raw jsonb                              -- provider payload minus large parts (attachment names only)
);
create index inbox_messages_received_idx on public.inbox_messages (received_at desc);
create index inbox_messages_unread_idx on public.inbox_messages (received_at desc) where read_at is null;

alter table public.inbox_messages enable row level security;

-- Admins read/update (mark read). No client insert — the email-inbound function
-- writes with the service role.
create policy "Admins read inbox"
  on public.inbox_messages for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));
create policy "Admins update inbox"
  on public.inbox_messages for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- The two builtin tools (tools-as-data; kind 'builtin'), seeded like
-- search_documents in 0012. send_email is exfiltration-capable, so it composes
-- with the usual controls (admin activation, agent tool_ids scoping, and the
-- webhooks.allow_tools gate).
insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'send_email',
  'Send an email from the workspace. Use when the user asks to email someone or to send themselves something.',
  '{"type":"object","properties":{"to":{"type":"string","description":"Recipient email address"},"subject":{"type":"string","description":"Email subject line"},"body":{"type":"string","description":"Plain-text body of the email"}},"required":["to","subject","body"]}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'send_email');

insert into public.tools (name, description, input_schema, kind, is_builtin, is_active, created_by)
select 'check_email',
  'Check the workspace inbox for recent incoming email.',
  '{"type":"object","properties":{"unread_only":{"type":"boolean","description":"Only return unread messages (default true)"},"limit":{"type":"integer","description":"Max messages to return (default 10, max 25)"},"mark_read":{"type":"boolean","description":"Mark the returned messages as read (default false)"}}}'::jsonb,
  'builtin', true, true,
  (select id from public.profiles order by created_at asc limit 1)
where not exists (select 1 from public.tools where name = 'check_email');
