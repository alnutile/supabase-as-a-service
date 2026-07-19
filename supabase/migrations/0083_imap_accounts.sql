-- IMAP account connectors — pull a real mailbox into the unified inbox.
--
-- The unified inbox (0064) can already be *pushed* to (email-inbound / message-
-- inbound / save_message). This adds the first PULL connector: a member connects
-- a real mailbox (Gmail app-password, Fastmail, a work IMAP server, …) and a
-- cron-ticked edge function polls it and funnels new mail into `inbox_messages`.
--
-- Why polling and not a live IMAP socket: edge functions are request-scoped and
-- can't hold a stateful TCP connection open, so the `imap-poll` function does a
-- short poll-and-disconnect on each pg_cron tick (same tick+secret convention as
-- the scheduler / event-dispatch). Each account carries its own UID cursor so a
-- poll only fetches mail newer than the last one it saw.
--
-- Secrets live ONLY in Supabase Vault (same pattern as the email integration in
-- 0016): the row holds a `secret_id` pointer, the password is written through the
-- security-definer RPC `set_imap_account`, and only the service role reads the
-- decrypted value via `read_imap_secret`. The password is never a table column,
-- never in a client payload, never logged.

create extension if not exists supabase_vault;

-- Per-user IMAP accounts. Unlike the single workspace email integration, these
-- are personal: any member connects their own mailbox(es), owned by them, and
-- chooses whether the mail it pulls is private or shared with the workspace.
create table public.imap_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  label text not null default '',                 -- display label ("Work Gmail")
  host text not null,                             -- imap.gmail.com
  port integer not null default 993,
  username text not null,                         -- login (usually the address)
  secret_id uuid not null,                        -- vault.secrets.id holding the password
  folder text not null default 'INBOX',
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  mark_seen boolean not null default true,        -- flag fetched messages \Seen on the server
  is_active boolean not null default true,
  poll_interval_minutes integer not null default 5 check (poll_interval_minutes between 1 and 1440),
  last_uid bigint not null default 0,             -- highest UID fetched (scoped to uid_validity)
  uid_validity bigint,                            -- reset last_uid when the server's UIDVALIDITY changes
  last_polled_at timestamptz,
  last_status text,                               -- 'ok' | 'error'
  last_error text,
  next_poll_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index imap_accounts_due_idx on public.imap_accounts (next_poll_at) where is_active;
create index imap_accounts_owner_idx on public.imap_accounts (owner_id);

alter table public.imap_accounts enable row level security;

-- Owners (and admins) read/manage their own accounts. Writes go through the
-- security-definer RPCs below, so there is no client insert/update policy — but
-- owners may deactivate/delete their own rows directly, and read them for the UI.
-- The row only exposes a `secret_id` pointer (a bare uuid); the password itself
-- is unreachable without the service role.
create policy "Owners read their imap accounts"
  on public.imap_accounts for select
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );
create policy "Owners update their imap accounts"
  on public.imap_accounts for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
create policy "Owners delete their imap accounts"
  on public.imap_accounts for delete
  using (owner_id = auth.uid());

-- Admin-gated? No — accounts are personal, so ownership is the boundary. The RPC
-- is security-definer and enforces owner = auth.uid() (auth.uid() wins; a null
-- caller = service role is trusted). Password is write-only: an empty/null value
-- on update keeps the existing secret. Never returns the password. Returns the id.
create or replace function public.set_imap_account(
  p_id uuid,
  p_label text,
  p_host text,
  p_port integer,
  p_username text,
  p_password text,
  p_folder text default 'INBOX',
  p_visibility text default 'private',
  p_mark_seen boolean default true,
  p_poll_interval_minutes integer default 5
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.imap_accounts;
  v_secret_id uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if coalesce(trim(p_host), '') = '' then
    raise exception 'A host is required';
  end if;
  if coalesce(trim(p_username), '') = '' then
    raise exception 'A username is required';
  end if;
  if p_visibility not in ('private', 'workspace') then
    raise exception 'Invalid visibility: %', p_visibility;
  end if;

  if p_id is not null then
    select * into v_existing from public.imap_accounts where id = p_id;
    if v_existing.id is null then
      raise exception 'Account not found';
    end if;
    if v_existing.owner_id <> v_uid then
      raise exception 'Not your account';
    end if;
  end if;

  if v_existing.id is null then
    -- Create: a password is required.
    if coalesce(trim(p_password), '') = '' then
      raise exception 'A password is required to connect an account';
    end if;
    v_secret_id := vault.create_secret(
      p_password,
      'imap_pw_' || replace(gen_random_uuid()::text, '-', ''),
      'IMAP account password (' || coalesce(nullif(trim(p_label), ''), p_host) || ')'
    );
    insert into public.imap_accounts (
      owner_id, label, host, port, username, secret_id, folder,
      visibility, mark_seen, poll_interval_minutes, next_poll_at
    ) values (
      v_uid, coalesce(trim(p_label), ''), trim(p_host), coalesce(p_port, 993), trim(p_username),
      v_secret_id, coalesce(nullif(trim(p_folder), ''), 'INBOX'),
      p_visibility, coalesce(p_mark_seen, true), coalesce(p_poll_interval_minutes, 5), now()
    )
    returning id into v_id;
  else
    -- Update: rotate the secret only when a new password is supplied.
    if coalesce(trim(p_password), '') <> '' then
      perform vault.update_secret(v_existing.secret_id, p_password);
    end if;
    update public.imap_accounts set
      label = coalesce(trim(p_label), ''),
      host = trim(p_host),
      port = coalesce(p_port, 993),
      username = trim(p_username),
      folder = coalesce(nullif(trim(p_folder), ''), 'INBOX'),
      visibility = p_visibility,
      mark_seen = coalesce(p_mark_seen, true),
      poll_interval_minutes = coalesce(p_poll_interval_minutes, 5),
      updated_at = now()
    where id = p_id
    returning id into v_id;
  end if;

  return v_id;
end;
$$;
revoke execute on function public.set_imap_account(uuid, text, text, integer, text, text, text, text, boolean, integer) from anon, public;
grant execute on function public.set_imap_account(uuid, text, text, integer, text, text, text, text, boolean, integer) to authenticated;

-- Delete an account and its Vault secret. Owner-checked in the body.
create or replace function public.delete_imap_account(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing public.imap_accounts;
begin
  select * into v_existing from public.imap_accounts where id = p_id;
  if v_existing.id is null then
    return;
  end if;
  if v_existing.owner_id <> auth.uid() then
    raise exception 'Not your account';
  end if;
  delete from public.imap_accounts where id = p_id;
  delete from vault.secrets where id = v_existing.secret_id;
end;
$$;
revoke execute on function public.delete_imap_account(uuid) from anon, public;
grant execute on function public.delete_imap_account(uuid) to authenticated;

-- Service-role-only reader of the decrypted password (the imap-poll function
-- calls this). Execute is revoked from API roles so clients can never read it.
create or replace function public.read_imap_secret(p_account_id uuid)
returns text language sql stable security definer set search_path = public, vault as $$
  select s.decrypted_secret
  from public.imap_accounts a
  join vault.decrypted_secrets s on s.id = a.secret_id
  where a.id = p_account_id;
$$;
revoke execute on function public.read_imap_secret(uuid) from anon, authenticated, public;

-- Tick every minute → call the imap-poll edge function, which claims any account
-- whose next_poll_at is due (each account throttles itself via poll_interval).
-- Applied out-of-band after the function is deployed (same convention as the
-- scheduler in 0010 and event-dispatch in 0063_events.sql):
--
-- select cron.schedule('poll-imap-accounts', '* * * * *', $$
--   select net.http_post(
--     url := 'https://<project-ref>.supabase.co/functions/v1/imap-poll',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--                                   'x-cron-secret', (select secret from public.cron_config limit 1)),
--     body := '{}'::jsonb
--   );
-- $$);
