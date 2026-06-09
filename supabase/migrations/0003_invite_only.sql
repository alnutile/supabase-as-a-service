-- Invite-only access.
-- The first user to ever sign up bootstraps the workspace and becomes admin.
-- After that, a signup only succeeds if the email is on the admin-managed
-- allowlist. Enforced at the database level via a BEFORE INSERT guard on
-- auth.users, so it can't be bypassed from the client.

-- 1. Admin flag on profiles (first profile becomes admin).
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Backfill: the oldest existing user becomes the admin.
update public.profiles
set is_admin = true
where id = (select id from public.profiles order by created_at asc limit 1)
  and not exists (select 1 from public.profiles where is_admin);

-- Recreate the new-user handler so the very first profile is made admin.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, is_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    (select count(*) from public.profiles) = 0
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 2. Allowlist of invited emails (admin-managed).
create table public.allowed_emails (
  email text primary key,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.allowed_emails enable row level security;

create policy "Admins view the allowlist"
  on public.allowed_emails for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create policy "Admins add invites"
  on public.allowed_emails for insert
  with check (
    invited_by = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

create policy "Admins remove invites"
  on public.allowed_emails for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- 3. The guard: allow the first user, or any allowlisted email; reject the rest.
create or replace function public.enforce_invite_only()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if (select count(*) from auth.users) = 0 then
    return new; -- first user bootstraps the workspace
  end if;
  if new.email is not null and exists (
    select 1 from public.allowed_emails ae where lower(ae.email) = lower(new.email)
  ) then
    return new;
  end if;
  raise exception 'This workspace is invite-only. Ask an admin to invite %.', new.email
    using errcode = 'check_violation';
end;
$$;

revoke execute on function public.enforce_invite_only() from anon, authenticated, public;

create trigger before_auth_user_created
  before insert on auth.users
  for each row execute function public.enforce_invite_only();
