-- 0102_email_accounts.sql
-- IMAP email inboxes ("Add an inbox") — pull email into the unified inbox.
--
-- Until now email only arrived by PUSH (a provider's inbound-parse POSTing to
-- email-inbound, or a POST to message-inbound). This adds PULL: an admin/member
-- registers an IMAP mailbox and the workspace polls it. New mail lands in
-- `inbox_messages` (source='email') — which already emits `message.received`
-- (0064) — so from the Listeners page you route it exactly like a webhook
-- ("drop each new email into the logs table" via run_tool: add_table_row).
--
-- Same Vault-backed secret pattern as the email key (0016) / vault secrets
-- (0037): the mailbox PASSWORD lives ONLY in Supabase Vault (`secret_id`
-- pointer); the table holds just connection metadata. Writes go through the
-- security-definer RPCs below (no client insert/update/delete policies); the
-- decrypted password is read ONLY by the service role (the email-poll edge
-- function) via `read_email_account_secret`.
--
-- Sharing mirrors links/todos/vault_secrets: `private` (owner + admins) or
-- `workspace` (every member sees the account; ingested mail inherits the
-- account's visibility). Use an app password (see docs/events-and-inbox.md) —
-- providers reject the real login password over IMAP once 2FA is on.

create extension if not exists supabase_vault;

create table public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null default '',                 -- display name ("Monitoring inbox")
  host text not null,                             -- e.g. imap.gmail.com
  port int not null default 993,
  secure boolean not null default true,           -- implicit TLS (993). false = plain (rare)
  username text not null,                         -- usually the full email address
  secret_id uuid not null,                        -- vault.secrets id holding the password
  folder text not null default 'INBOX',
  last_seen_uid bigint not null default 0,        -- highest IMAP UID already ingested
  poll_interval_minutes int not null default 5 check (poll_interval_minutes between 1 and 1440),
  visibility text not null default 'private' check (visibility in ('private', 'workspace')),
  owner_id uuid references auth.users (id) on delete cascade,
  active boolean not null default true,
  last_checked_at timestamptz,
  last_error text,                                -- last poll error (null = healthy)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_accounts enable row level security;

-- Visible to its owner, to everyone when workspace-shared, or to admins. The
-- password is NOT here (it's in Vault), so this only exposes connection metadata.
create policy "Read email accounts"
  on public.email_accounts for select
  using (
    owner_id = auth.uid()
    or visibility = 'workspace'
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

alter publication supabase_realtime add table public.email_accounts;

-- Upsert RPC. p_id null → create (mints a Vault secret); else update (password
-- write-only: an empty p_password keeps the existing one). Owner or admin only.
create or replace function public.set_email_account(
  p_id uuid,
  p_label text,
  p_host text,
  p_port int,
  p_secure boolean,
  p_username text,
  p_password text,
  p_folder text default 'INBOX',
  p_visibility text default 'private',
  p_poll_interval_minutes int default 5,
  p_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing public.email_accounts;
  v_secret_id uuid;
  v_host text;
  v_username text;
  v_vis text;
  v_port int;
  v_interval int;
  v_id uuid;
  v_is_admin boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  v_host := lower(trim(coalesce(p_host, '')));
  v_username := trim(coalesce(p_username, ''));
  if v_host = '' or v_username = '' then
    raise exception 'Host and username are required';
  end if;
  v_vis := lower(coalesce(nullif(trim(p_visibility), ''), 'private'));
  if v_vis not in ('private', 'workspace') then
    raise exception 'Visibility must be private or workspace';
  end if;
  v_port := coalesce(p_port, 993);
  if v_port < 1 or v_port > 65535 then
    raise exception 'Invalid port';
  end if;
  v_interval := least(greatest(coalesce(p_poll_interval_minutes, 5), 1), 1440);

  if p_id is null then
    if coalesce(trim(p_password), '') = '' then
      raise exception 'A password is required to add an inbox';
    end if;
    v_secret_id := vault.create_secret(
      p_password,
      'email_account_' || replace(gen_random_uuid()::text, '-', ''),
      'IMAP inbox password (' || v_username || ')'
    );
    insert into public.email_accounts (
      label, host, port, secure, username, secret_id, folder, visibility,
      poll_interval_minutes, owner_id, active
    )
    values (
      coalesce(trim(p_label), ''), v_host, v_port, coalesce(p_secure, true), v_username,
      v_secret_id, coalesce(nullif(trim(p_folder), ''), 'INBOX'), v_vis, v_interval,
      auth.uid(), coalesce(p_active, true)
    )
    returning id into v_id;
    return v_id;
  end if;

  select * into v_existing from public.email_accounts where id = p_id;
  if v_existing.id is null then
    raise exception 'Inbox not found';
  end if;
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if v_existing.owner_id <> auth.uid() and not coalesce(v_is_admin, false) then
    raise exception 'Not allowed to edit this inbox';
  end if;

  if coalesce(trim(p_password), '') <> '' then
    perform vault.update_secret(v_existing.secret_id, p_password);
  end if;
  update public.email_accounts
    set label = coalesce(trim(p_label), ''),
        host = v_host,
        port = v_port,
        secure = coalesce(p_secure, true),
        username = v_username,
        folder = coalesce(nullif(trim(p_folder), ''), 'INBOX'),
        visibility = v_vis,
        poll_interval_minutes = v_interval,
        active = coalesce(p_active, true),
        updated_at = now()
    where id = p_id;
  return p_id;
end;
$$;
revoke execute on function public.set_email_account(uuid, text, text, int, boolean, text, text, text, text, int, boolean) from anon, public;
grant execute on function public.set_email_account(uuid, text, text, int, boolean, text, text, text, text, int, boolean) to authenticated;

-- Delete: owner or admin. Removes the row and its Vault secret.
create or replace function public.delete_email_account(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_owner uuid;
  v_is_admin boolean;
begin
  select secret_id, owner_id into v_secret_id, v_owner from public.email_accounts where id = p_id;
  if v_secret_id is null then
    return;
  end if;
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if v_owner <> auth.uid() and not coalesce(v_is_admin, false) then
    raise exception 'Not allowed to delete this inbox';
  end if;
  delete from public.email_accounts where id = p_id;
  delete from vault.secrets where id = v_secret_id;
end;
$$;
revoke execute on function public.delete_email_account(uuid) from anon, public;
grant execute on function public.delete_email_account(uuid) to authenticated;

-- Service-role-only reader: the email-poll function decrypts the password by
-- account id. Not callable by anon/authenticated (edge functions use the
-- service role).
create or replace function public.read_email_account_secret(p_account_id uuid)
returns text language sql stable security definer set search_path = public, vault as $$
  select s.decrypted_secret
  from public.email_accounts a
  join vault.decrypted_secrets s on s.id = a.secret_id
  where a.id = p_account_id
  limit 1;
$$;
revoke execute on function public.read_email_account_secret(uuid) from anon, authenticated, public;

-- Teach every tenant to self-schedule the IMAP poll tick (same mechanism as
-- 0094/0100: the deploy pipeline calls setup_automation_cron post-migration,
-- so this reschedules on every tenant automatically). The poller itself honors
-- each account's poll_interval_minutes, so a 1-minute tick is safe.
create or replace function public._automation_cron_jobs()
returns table (job_name text, fn text, sched text)
language sql
immutable
as $$
  select * from (values
    ('dispatch-events',   'event-dispatch', '* * * * *'),
    ('run-due-schedules', 'scheduler',      '* * * * *'),
    ('run-ingest',        'ingest',         '* * * * *'),
    ('run-email-poll',    'email-poll',     '* * * * *')
  ) as t(job_name, fn, sched);
$$;

notify pgrst, 'reload schema';
