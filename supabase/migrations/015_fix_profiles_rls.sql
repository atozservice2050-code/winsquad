-- Migration 015: profiles RLS (SAFE VERSION — supersedes the earlier draft)
--
-- SECURITY CORRECTION (2026-10-13): the earlier draft of this file used
--   create policy "profiles_select_own" ... using (true)
-- which would have exposed EVERY profile row (phone numbers, 14-digit
-- transfer IDs, referral IDs) to ALL authenticated users. That draft was
-- deliberately NEVER applied to production. This safe version is idempotent
-- with migration 014: it guarantees the own-profile-only SELECT policy and
-- changes nothing else. Applying this file is safe.

-- Drop any unsafe variants first (cleanup; no-ops if absent).
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_select_all" on public.profiles;

-- Users may read ONLY their own full profile row.
create policy "profiles_select_own"
  on public.profiles for select to authenticated
  using (auth.uid() = id);

-- get_my_profile RPC: ensure the authenticated role can execute it
-- (least privilege: NOT granted to anon).
grant execute on function public.get_my_profile() to authenticated;
