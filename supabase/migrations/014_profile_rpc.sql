-- Migration 014: Secure profile fetch RPC (bypasses RLS issues)
-- The profiles_select_own RLS policy was blocking authenticated users
-- from reading their own profile. This SECURITY DEFINER function
-- provides a reliable way to fetch the current user's profile.

create or replace function public.get_my_profile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  
  select * into v_profile
  from public.profiles
  where id = v_uid;
  
  if v_profile.id is null then
    return jsonb_build_object('ok', false, 'error', 'profile not found');
  end if;
  
  return jsonb_build_object(
    'ok', true,
    'profile', row_to_json(v_profile)
  );
end;
$$;

-- Grant execute to authenticated users
grant execute on function public.get_my_profile() to authenticated;

-- Also ensure the RLS policy is correct (recreate it)
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using (auth.uid() = id);
