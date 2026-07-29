-- 0103_email_account_mark_seen.sql
-- Follow-up to 0102 (IMAP inboxes). Two additions surfaced while testing the
-- first real mailbox:
--
--   1. `mark_seen` — after the poller ingests a message it can mark it \Seen
--      (read) on the IMAP server, so the mailbox reflects what's been pulled.
--      Default true; a per-account toggle in the editor turns it off for folders
--      you'd rather not touch.
--
--   2. `reset_email_account_cursor(id)` — sets `last_seen_uid` back to 0 so the
--      next poll re-imports the most recent mail. Needed because there is no
--      client UPDATE policy on email_accounts (writes go through RPCs), and a
--      "Re-scan inbox" button in the editor calls this. Owner or admin only.
--
-- (The 0102 poller also had a bug where a failed insert silently advanced the
-- cursor — fixed in the edge function, not here — so existing inboxes may have a
-- non-zero cursor with nothing ingested; Re-scan recovers them.)

alter table public.email_accounts
  add column if not exists mark_seen boolean not null default true;

-- Recreate set_email_account with a p_mark_seen parameter. Adding an argument
-- changes the function signature, so the old 11-arg version must be dropped first
-- (Postgres identifies functions by their argument list).
drop function if exists public.set_email_account(uuid, text, text, int, boolean, text, text, text, text, int, boolean);

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
  p_active boolean default true,
  p_mark_seen boolean default true
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
      poll_interval_minutes, owner_id, active, mark_seen
    )
    values (
      coalesce(trim(p_label), ''), v_host, v_port, coalesce(p_secure, true), v_username,
      v_secret_id, coalesce(nullif(trim(p_folder), ''), 'INBOX'), v_vis, v_interval,
      auth.uid(), coalesce(p_active, true), coalesce(p_mark_seen, true)
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
        mark_seen = coalesce(p_mark_seen, true),
        updated_at = now()
    where id = p_id;
  return p_id;
end;
$$;
revoke execute on function public.set_email_account(uuid, text, text, int, boolean, text, text, text, text, int, boolean, boolean) from anon, public;
grant execute on function public.set_email_account(uuid, text, text, int, boolean, text, text, text, text, int, boolean, boolean) to authenticated;

-- Reset the ingest cursor so the next poll re-imports recent mail. Owner or admin.
create or replace function public.reset_email_account_cursor(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_is_admin boolean;
begin
  select owner_id into v_owner from public.email_accounts where id = p_account_id;
  if v_owner is null then
    raise exception 'Inbox not found';
  end if;
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if v_owner <> auth.uid() and not coalesce(v_is_admin, false) then
    raise exception 'Not allowed to edit this inbox';
  end if;
  update public.email_accounts
    set last_seen_uid = 0, last_error = null, updated_at = now()
    where id = p_account_id;
end;
$$;
revoke execute on function public.reset_email_account_cursor(uuid) from anon, public;
grant execute on function public.reset_email_account_cursor(uuid) to authenticated;

notify pgrst, 'reload schema';
