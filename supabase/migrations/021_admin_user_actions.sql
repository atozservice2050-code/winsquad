-- 021: Admin user actions — block/unblock and delete users.
-- Run in Supabase SQL editor.

-- 1. Blocked flag on profiles
alter table public.profiles
  add column if not exists is_blocked boolean not null default false;

-- 2. Block / unblock a user (admin only)
create or replace function public.admin_block_user(target_user_id uuid, blocked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Access denied. Not an admin.';
  end if;
  -- Never block yourself
  if target_user_id = auth.uid() then
    raise exception 'You cannot block your own account.';
  end if;
  update public.profiles set is_blocked = blocked where id = target_user_id;
  if not found then
    raise exception 'User not found.';
  end if;
end;
$$;

-- 3. Delete a user entirely (admin only). Cascades to profiles, wallets, etc.
create or replace function public.admin_delete_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Access denied. Not an admin.';
  end if;
  -- Never delete yourself
  if target_user_id = auth.uid() then
    raise exception 'You cannot delete your own account.';
  end if;
  delete from auth.users where id = target_user_id;
  if not found then
    raise exception 'User not found.';
  end if;
end;
$$;
