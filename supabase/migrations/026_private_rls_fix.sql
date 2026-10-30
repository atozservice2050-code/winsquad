-- ============================================================================
-- 026 — Fix private-table RLS infinite recursion (empty-seats bug).
--
-- Bug: policy "ps_select_member" on public.private_seats checks membership
-- by querying public.private_seats ITSELF inside its own USING clause.
-- Postgres raises "infinite recursion detected in policy for relation
-- private_seats" on EVERY client select, so the app received an error,
-- treated it as zero rows, and rendered all 4 seats "Empty seat" for
-- everyone — creator and joiners alike. The pt_/pb_ policies reference
-- private_seats too, so private_tables / private_bids reads failed the
-- same way. Writes were unaffected (create/join/bid RPCs are SECURITY
-- DEFINER), which is why joining "worked" but nobody could see seats.
--
-- Fix: a SECURITY DEFINER membership helper (runs as owner, bypasses RLS,
-- so no recursion) used by all three member policies.
-- ============================================================================

create or replace function public.is_private_table_member(p_table_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.private_seats
    where table_id = p_table_id and user_id = auth.uid()
  );
$$;

grant execute on function public.is_private_table_member(uuid) to authenticated;

drop policy if exists "pt_select_member" on public.private_tables;
create policy "pt_select_member"
  on public.private_tables for select to authenticated
  using (public.is_private_table_member(id));

drop policy if exists "ps_select_member" on public.private_seats;
create policy "ps_select_member"
  on public.private_seats for select to authenticated
  using (public.is_private_table_member(table_id));

drop policy if exists "pb_select_member" on public.private_bids;
create policy "pb_select_member"
  on public.private_bids for select to authenticated
  using (public.is_private_table_member(table_id));
