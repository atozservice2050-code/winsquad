-- 023: 1xBet-style payments model for WinSquad (manual system):
--   * SadaPay + NayaPay added as payment account types
--   * KYC: CNIC stored on profiles, status flow unverified -> pending -> verified/rejected
--   * Turnover: user must have bet at least their total approved deposits (1x)
--     before a withdrawal can be requested (enforced by trigger, not just UI)
--   * Same-account rule: a withdrawal row must reference a saved payment
--     account (transactions.account_id) owned by the user.
-- Run in Supabase SQL editor (after 022).

-- ---------- payment account types: add sadapay / nayapay ----------
alter table public.payment_accounts
  drop constraint if exists payment_accounts_type_check;
alter table public.payment_accounts
  add constraint payment_accounts_type_check
  check (type in ('easypaisa','jazzcash','bank','sadapay','nayapay'));

-- ---------- KYC on profiles ----------
alter table public.profiles
  add column if not exists cnic text;
alter table public.profiles
  add column if not exists kyc_status text not null default 'unverified';
alter table public.profiles
  drop constraint if exists profiles_kyc_status_check;
alter table public.profiles
  add constraint profiles_kyc_status_check
  check (kyc_status in ('unverified','pending','verified','rejected'));

-- Remember which saved account a withdrawal goes to
alter table public.transactions
  add column if not exists account_id uuid references public.payment_accounts(id) on delete set null;

-- ---------- totals helper (deposits approved, bets placed) ----------
create or replace function public.payment_totals(p_user uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'deposits', coalesce(sum(amount) filter (
      where type = 'deposit' and status in ('approved','completed')), 0),
    'turnover', coalesce(sum(amount) filter (
      where type in ('stake','coinflip_bet','dragontiger_bet','andarbahar_bet',
                     'roulette_bet','cv_bet','dice_bet')
        and status in ('approved','completed')), 0)
  )
  from public.transactions
  where user_id = p_user;
$$;

-- Own totals for the signed-in user (wallet UI)
create or replace function public.my_payment_totals()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('deposits', 0, 'turnover', 0);
  end if;
  return public.payment_totals(auth.uid());
end;
$$;

-- ---------- KYC submit (own profile) ----------
create or replace function public.submit_kyc(p_cnic text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cnic text := regexp_replace(coalesce(p_cnic, ''), '\D', '', 'g');
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if length(v_cnic) <> 13 then
    return jsonb_build_object('ok', false, 'error', 'CNIC must be 13 digits');
  end if;
  update public.profiles
    set cnic = v_cnic, kyc_status = 'pending'
    where id = v_uid;
  return jsonb_build_object('ok', true, 'status', 'pending');
end;
$$;

-- ---------- KYC admin decision ----------
create or replace function public.admin_set_kyc(target_user_id uuid, new_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Access denied. Not an admin.';
  end if;
  if new_status not in ('verified','rejected','pending','unverified') then
    raise exception 'Invalid status.';
  end if;
  update public.profiles set kyc_status = new_status where id = target_user_id;
  if not found then
    raise exception 'User not found.';
  end if;
end;
$$;

-- ---------- Withdrawal gate (server-side enforcement) ----------
create or replace function public.enforce_withdraw_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_totals jsonb;
  v_status text;
  v_owner uuid;
begin
  if new.type <> 'withdraw' then
    return new;
  end if;
  -- Admins / service role may insert adjustments directly
  if public.is_admin() or auth.role() = 'service_role' then
    return new;
  end if;
  -- 1. Verification required before first withdrawal
  select kyc_status into v_status from public.profiles where id = new.user_id;
  if coalesce(v_status, 'unverified') <> 'verified' then
    raise exception 'Account not verified. Add your CNIC in Wallet > Accounts and wait for approval before withdrawing.';
  end if;
  -- 2. Turnover: total bets must be >= total approved deposits (1x)
  v_totals := public.payment_totals(new.user_id);
  if (v_totals ->> 'turnover')::numeric < (v_totals ->> 'deposits')::numeric then
    raise exception 'Turnover incomplete: you must play your full deposit amount before withdrawing.';
  end if;
  -- 3. Same-account rule: withdrawal must go to one of the user's saved accounts
  if new.account_id is null then
    raise exception 'Select a saved account for your withdrawal (Wallet > Accounts).';
  end if;
  select user_id into v_owner from public.payment_accounts where id = new.account_id;
  if v_owner is null or v_owner <> new.user_id then
    raise exception 'Withdrawals can only go to your own saved account.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_withdraw_rules on public.transactions;
create trigger trg_enforce_withdraw_rules
  before insert on public.transactions
  for each row execute function public.enforce_withdraw_rules();

-- payment_totals takes an arbitrary user id: keep it internal only
revoke execute on function public.payment_totals(uuid) from public, anon, authenticated;

grant execute on function public.my_payment_totals() to authenticated;
grant execute on function public.submit_kyc(text) to authenticated;
grant execute on function public.admin_set_kyc(uuid, text) to authenticated;
