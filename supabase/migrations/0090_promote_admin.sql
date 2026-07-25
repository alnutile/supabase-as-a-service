-- Promote members to admin as a recovery path.
-- Addresses the "single admin" finding from the Security dashboard.

-- 1. Update list_workspace_members to include is_admin status.
-- The 0053 version returns (id, email, display_name); adding is_admin CHANGES the
-- return type, and Postgres rejects `create or replace` on a return-type change
-- (SQLSTATE 42P13) — so drop it first. Safe: it's an RPC called from the client,
-- not referenced by other DB objects.
drop function if exists public.list_workspace_members();
create or replace function public.list_workspace_members()
  returns table (id uuid, email text, display_name text, is_admin boolean)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select p.id, p.email, p.display_name, p.is_admin
  from public.profiles p
  order by coalesce(p.display_name, p.email)
$$;

-- 2. Add an admin-only RPC to promote a user to admin
create or replace function public.promote_to_admin(target_user_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- Only admins can promote users
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_admin = true
  ) then
    raise exception 'Only admins can promote users to admin'
      using errcode = 'insufficient_privilege';
  end if;

  -- Can't promote yourself (you're already admin)
  if target_user_id = auth.uid() then
    raise exception 'You are already an admin'
      using errcode = 'check_violation';
  end if;

  -- Check if the target user exists
  if not exists (
    select 1 from public.profiles where id = target_user_id
  ) then
    raise exception 'User not found'
      using errcode = 'foreign_key_violation';
  end if;

  -- Check if the user is already an admin
  if exists (
    select 1 from public.profiles
    where id = target_user_id and is_admin = true
  ) then
    raise exception 'User is already an admin'
      using errcode = 'check_violation';
  end if;

  -- Promote the user to admin
  update public.profiles
  set is_admin = true, updated_at = now()
  where id = target_user_id;
end;
$$;

-- Grant execute only to authenticated users (the function itself checks for admin)
revoke execute on function public.promote_to_admin(uuid) from anon, public;
grant execute on function public.promote_to_admin(uuid) to authenticated;
