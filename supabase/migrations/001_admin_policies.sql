-- ============================================================================
-- WinSquad — Migration 001: Admin RLS policies + withdraw approval
-- Run AFTER schema.sql via Supabase Dashboard > SQL Editor.
-- ============================================================================
--
-- This migration enables the client-side Admin Portal (frontend/admin.html).
-- It adds RLS policies so users in the public.admins table can read all
-- operational data (including the HIDDEN fee_amount columns), plus RPCs for
-- approving/rejecting withdrawals.
--
-- SECURITY MODEL:
--   * All policies gate on public.is_admin() (SECURITY DEFINER), which checks
--     public.admins for auth.uid(). Non-admins are unaffected.
--   * fee_amount (rounds + private_tables) remains hidden from regular users:
--     there is still NO select policy on rounds for non-admins.
--   * approve/reject RPCs check is_admin() internally (defense in depth).
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Admin SELECT policies (read-only access to all operational tables)
-- ----------------------------------------------------------------------------

-- profiles: admins see all (phone, referral_id, transfer_id, etc.)
drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin"
  on public.profiles for select to authenticated
  using (public.is_admin());

-- wallets: admins see all balances
drop policy if exists "wallets_select_admin" on public.wallets;
create policy "wallets_select_admin"
  on public.wallets for select to authenticated
  using (public.is_admin());

-- transactions: admins see the full money ledger
drop policy if exists "txn_select_admin" on public.transactions;
create policy "txn_select_admin"
  on public.transactions for select to authenticated
  using (public.is_admin());

-- rounds: admins see all INCLUDING the hidden fee_amount (10% company cut).
-- Regular users still have NO select policy on rounds (fee stays hidden).
drop policy if exists "rounds_select_admin" on public.rounds;
create policy "rounds_select_admin"
  on public.rounds for select to authenticated
  using (public.is_admin());

-- bids: admins see all bid amounts (hidden from regular users by design)
drop policy if exists "bids_select_admin" on public.bids;
create policy "bids_select_admin"
  on public.bids for select to authenticated
  using (public.is_admin());

-- private tables / seats / bids: admins see all
drop policy if exists "pt_select_admin" on public.private_tables;
create policy "pt_select_admin"
  on public.private_tables for select to authenticated
  using (public.is_admin());

drop policy if exists "ps_select_admin" on public.private_seats;
create policy "ps_select_admin"
  on public.private_seats for select to authenticated
  using (public.is_admin());

drop policy if exists "pb_select_admin" on public.private_bids;
create policy "pb_select_admin"
  on public.private_bids for select to authenticated
  using (public.is_admin());

-- rewards / streaks: admins see all
drop policy if exists "rewards_select_admin" on public.rewards;
create policy "rewards_select_admin"
  on public.rewards for select to authenticated
  using (public.is_admin());

drop policy if exists "streaks_select_admin" on public.streaks;
create policy "streaks_select_admin"
  on public.streaks for select to authenticated
  using (public.is_admin());

-- admins: admins can see the admin list (to manage it)
drop policy if exists "admins_select_admin" on public.admins;
create policy "admins_select_admin"
  on public.admins for select to authenticated
  using (public.is_admin());

-- Grants needed for the two tables that had NO client grants before.
-- (All other tables already grant select to authenticated; the new policies
--  above are what actually restrict rows to admins.)
grant select on public.rounds to authenticated;
grant select on public.admins to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Withdraw approval RPCs (admin / service_role only)
-- ----------------------------------------------------------------------------
-- Flow: user INSERTs a withdraw transaction (status='pending', method +
-- note required). Admin approves -> wallet deducted atomically + marked
-- completed. Admin rejects -> marked rejected, no wallet movement.
-- (Money is deducted at APPROVAL time to prevent double-spend.)

create or replace function public.approve_withdraw(p_txn_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.transactions%rowtype;
begin
  if not (public.is_admin() or auth.role() = 'service_role') then
    return jsonb_build_object('ok', false, 'error', 'not authorized');
  end if;
  if p_txn_id is null then
    return jsonb_build_object('ok', false, 'error', 'transaction id required');
  end if;

  select * into v_txn from public.transactions where id = p_txn_id for update;
  if v_txn.id is null then
    return jsonb_build_object('ok', false, 'error', 'transaction not found');
  end if;
  if v_txn.type <> 'withdraw' then
    return jsonb_build_object('ok', false, 'error', 'not a withdrawal');
  end if;
  if v_txn.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'withdrawal already ' || v_txn.status);
  end if;

  -- atomic debit; fails cleanly on insufficient balance
  update public.wallets
  set balance = balance - v_txn.amount, updated_at = now()
  where user_id = v_txn.user_id and balance >= v_txn.amount;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'insufficient balance');
  end if;

  update public.transactions set status = 'completed' where id = p_txn_id;

  return jsonb_build_object('ok', true, 'user_id', v_txn.user_id,
                            'amount', v_txn.amount);
end;
$$;

create or replace function public.reject_withdraw(p_txn_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.transactions%rowtype;
begin
  if not (public.is_admin() or auth.role() = 'service_role') then
    return jsonb_build_object('ok', false, 'error', 'not authorized');
  end if;
  if p_txn_id is null then
    return jsonb_build_object('ok', false, 'error', 'transaction id required');
  end if;

  select * into v_txn from public.transactions where id = p_txn_id for update;
  if v_txn.id is null then
    return jsonb_build_object('ok', false, 'error', 'transaction not found');
  end if;
  if v_txn.type <> 'withdraw' or v_txn.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'withdrawal is not pending');
  end if;

  update public.transactions set status = 'rejected' where id = p_txn_id;

  return jsonb_build_object('ok', true, 'user_id', v_txn.user_id,
                            'amount', v_txn.amount);
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Lock down new functions: authenticated only (service_role bypasses)
-- ----------------------------------------------------------------------------
do $$
declare
  v_sig text;
begin
  for v_sig in
    select format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_withdraw', 'reject_withdraw')
  loop
    execute 'revoke all on function ' || v_sig || ' from public';
    execute 'grant execute on function ' || v_sig || ' to authenticated';
  end loop;
end
$$;

-- ============================================================================
-- POST-RUN: open frontend/admin.html, sign in with your admin phone number.
-- Make yourself admin first (if not done):
--   insert into public.admins (user_id) values ('YOUR-auth.users-UUID');
-- ============================================================================
