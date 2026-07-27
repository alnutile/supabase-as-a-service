-- User management: disable accounts and remove users
-- Addresses issue #263: admins should be able to remove people from the system

-- 1. Add disabled flag to profiles for soft delete (safer, reversible)
alter table public.profiles add column if not exists disabled boolean not null default false;

-- 2. Add disabled_at timestamp to track when account was disabled
alter table public.profiles add column if not exists disabled_at timestamptz;

-- 3. Update list_workspace_members to include disabled status
-- Must drop first because we're changing the return type
drop function if exists public.list_workspace_members();
create or replace function public.list_workspace_members()
  returns table (id uuid, email text, display_name text, is_admin boolean, disabled boolean)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select p.id, p.email, p.display_name, p.is_admin, p.disabled
  from public.profiles p
  order by p.disabled asc, coalesce(p.display_name, p.email)
$$;

-- 4. Add RPC to disable a user (soft delete)
create or replace function public.disable_user(target_user_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- Only admins can disable users
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_admin = true
  ) then
    raise exception 'Only admins can disable users'
      using errcode = 'insufficient_privilege';
  end if;

  -- Can't disable yourself
  if target_user_id = auth.uid() then
    raise exception 'You cannot disable your own account'
      using errcode = 'check_violation';
  end if;

  -- Check if the target user exists
  if not exists (
    select 1 from public.profiles where id = target_user_id
  ) then
    raise exception 'User not found'
      using errcode = 'foreign_key_violation';
  end if;

  -- Check if user is already disabled
  if exists (
    select 1 from public.profiles
    where id = target_user_id and disabled = true
  ) then
    raise exception 'User is already disabled'
      using errcode = 'check_violation';
  end if;

  -- Prevent disabling the last admin
  if exists (
    select 1 from public.profiles
    where id = target_user_id and is_admin = true
  ) and (
    select count(*) from public.profiles
    where is_admin = true and disabled = false
  ) <= 1 then
    raise exception 'Cannot disable the last admin. Promote another user first.'
      using errcode = 'check_violation';
  end if;

  -- Disable the user
  update public.profiles
  set disabled = true, disabled_at = now(), updated_at = now()
  where id = target_user_id;
end;
$$;

-- 5. Add RPC to re-enable a user
create or replace function public.enable_user(target_user_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- Only admins can enable users
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_admin = true
  ) then
    raise exception 'Only admins can enable users'
      using errcode = 'insufficient_privilege';
  end if;

  -- Check if the target user exists
  if not exists (
    select 1 from public.profiles where id = target_user_id
  ) then
    raise exception 'User not found'
      using errcode = 'foreign_key_violation';
  end if;

  -- Check if user is actually disabled
  if not exists (
    select 1 from public.profiles
    where id = target_user_id and disabled = true
  ) then
    raise exception 'User is not disabled'
      using errcode = 'check_violation';
  end if;

  -- Re-enable the user
  update public.profiles
  set disabled = false, disabled_at = null, updated_at = now()
  where id = target_user_id;
end;
$$;

-- 6. Add RPC to permanently delete a user (hard delete - use with caution)
-- This deletes the user from auth.users, which cascades to profiles and their content
create or replace function public.delete_user(target_user_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- Only admins can delete users
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and is_admin = true
  ) then
    raise exception 'Only admins can delete users'
      using errcode = 'insufficient_privilege';
  end if;

  -- Can't delete yourself
  if target_user_id = auth.uid() then
    raise exception 'You cannot delete your own account'
      using errcode = 'check_violation';
  end if;

  -- Check if the target user exists
  if not exists (
    select 1 from public.profiles where id = target_user_id
  ) then
    raise exception 'User not found'
      using errcode = 'foreign_key_violation';
  end if;

  -- Prevent deleting the last admin
  if exists (
    select 1 from public.profiles
    where id = target_user_id and is_admin = true
  ) and (
    select count(*) from public.profiles
    where is_admin = true and id != target_user_id
  ) < 1 then
    raise exception 'Cannot delete the last admin. Promote another user first.'
      using errcode = 'check_violation';
  end if;

  -- Delete from auth.users (cascades to profiles due to ON DELETE CASCADE)
  delete from auth.users where id = target_user_id;
end;
$$;

-- Grant execute permissions to authenticated users (functions check for admin internally)
revoke execute on function public.disable_user(uuid) from anon, public;
grant execute on function public.disable_user(uuid) to authenticated;

revoke execute on function public.enable_user(uuid) from anon, public;
grant execute on function public.enable_user(uuid) to authenticated;

revoke execute on function public.delete_user(uuid) from anon, public;
grant execute on function public.delete_user(uuid) to authenticated;

-- Update existing policies to exclude disabled users from most operations
-- Note: This is commented out as it would be a breaking change.
-- In production, you'd want to audit all RLS policies and decide which should exclude disabled users.
-- For now, disabled users can still sign in but admins can see they're disabled.
