-- Shareable invite links.
-- The existing invite flow (0003) adds an email to `allowed_emails` and the
-- person signs up with that exact address. This adds a second option: an admin
-- mints an opaque link they can hand out (Slack, DM, wherever). When the
-- recipient opens it and signs up, the link's redeem RPC allowlists whatever
-- email they enter — so the same DB-level `enforce_invite_only()` guard (0003)
-- keeps protecting signups; the link just authorizes the email on the fly.

-- 1. The links. Opaque UUID token in the URL (same "secret-URL" model as
--    webhooks). Optional expiry + max_uses so a link can be scoped; both null
--    means an open, unlimited link. `active` is the revoke switch.
-- Idempotent (create table if not exists + drop-policy-if-exists guards): this
-- migration was originally shipped as a second `0078_*` file that collided with
-- 0078_dashboard_widgets, so `db push` re-ran it against a table that already
-- existed. Renumbered to 0081 and made re-runnable so applying it against a
-- workspace that already has the objects is a harmless no-op.
create table if not exists public.invite_links (
  id uuid primary key default gen_random_uuid(),
  token uuid not null default gen_random_uuid() unique,
  label text,
  created_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz,
  max_uses integer,
  uses integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.invite_links enable row level security;

-- Admin-only CRUD, mirroring allowed_emails.
drop policy if exists "Admins view invite links" on public.invite_links;
create policy "Admins view invite links"
  on public.invite_links for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

drop policy if exists "Admins create invite links" on public.invite_links;
create policy "Admins create invite links"
  on public.invite_links for insert
  with check (
    created_by = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "Admins update invite links" on public.invite_links;
create policy "Admins update invite links"
  on public.invite_links for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

drop policy if exists "Admins remove invite links" on public.invite_links;
create policy "Admins remove invite links"
  on public.invite_links for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- 2. Public status check so the /join page can tell a valid link from a
--    revoked/expired/used-up one BEFORE showing the signup form. Runs as
--    security definer (the link row is admin-only) but leaks nothing beyond
--    validity + the label.
create or replace function public.invite_link_status(p_token uuid)
returns table (valid boolean, reason text, label text)
language plpgsql
security definer
set search_path = public
as $$
declare
  lnk public.invite_links;
begin
  select * into lnk from public.invite_links where token = p_token;
  if not found or not lnk.active then
    return query select false, 'invalid'::text, null::text;
  elsif lnk.expires_at is not null and lnk.expires_at < now() then
    return query select false, 'expired'::text, null::text;
  elsif lnk.max_uses is not null and lnk.uses >= lnk.max_uses then
    return query select false, 'used_up'::text, null::text;
  else
    return query select true, 'ok'::text, lnk.label;
  end if;
end;
$$;

-- 3. Redeem: validate the token, then allowlist the email so the invite-only
--    signup guard lets it through. Callable by anon (the recipient isn't signed
--    in yet). It only ever adds an email to the allowlist — account creation is
--    still Supabase Auth's job — so there's no privilege escalation beyond
--    "this address may now sign up", which is exactly what the link grants.
create or replace function public.redeem_invite_link(p_token uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  lnk public.invite_links;
begin
  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'A valid email is required.' using errcode = 'check_violation';
  end if;

  -- Lock the row so concurrent redeems can't overshoot max_uses.
  select * into lnk from public.invite_links where token = p_token for update;

  if not found or not lnk.active then
    raise exception 'This invite link is not valid.' using errcode = 'check_violation';
  end if;
  if lnk.expires_at is not null and lnk.expires_at < now() then
    raise exception 'This invite link has expired.' using errcode = 'check_violation';
  end if;
  if lnk.max_uses is not null and lnk.uses >= lnk.max_uses then
    raise exception 'This invite link has reached its limit.' using errcode = 'check_violation';
  end if;

  insert into public.allowed_emails (email, invited_by)
  values (lower(p_email), lnk.created_by)
  on conflict (email) do nothing;

  update public.invite_links set uses = uses + 1 where id = lnk.id;
end;
$$;

revoke execute on function public.invite_link_status(uuid) from public;
revoke execute on function public.redeem_invite_link(uuid, text) from public;
grant execute on function public.invite_link_status(uuid) to anon, authenticated;
grant execute on function public.redeem_invite_link(uuid, text) to anon, authenticated;
