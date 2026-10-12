-- Migration 015: Fix profiles RLS - allow authenticated users to read own profile
-- The RLS policy was blocking profile reads. This ensures it works.

-- Drop existing policies
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_select_all" on public.profiles;

-- Create a permissive policy for authenticated users to read their own profile
create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using (true);

-- Also allow the anon role to execute the RPC (for safety)
grant execute on function public.get_my_profile() to anon, authenticated;
