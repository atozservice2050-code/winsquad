-- 024: Bonus wallet (1xBet-style) — game rewards are LOCKED until wagered.
--   * wallets.balance stays the TOTAL balance (all existing logic untouched).
--   * wallets.bonus_balance  = the locked part of the balance (not withdrawable)
--   * wallets.bonus_received = lifetime rewards received (progress display)
--   * Withdrawable = balance - bonus_balance.
-- Every reward credit in the system inserts a transactions row with
-- type='bonus' + status='completed' (welcome Rs 50, referral Rs 100/500,
-- daily streak, mission claims — and future game target rewards), so ONE
-- trigger locks them all. Every bet row (stake / *_bet) unlocks the same
-- amount of bonus. Withdrawals are gated server-side in
-- enforce_withdraw_rules(): the amount must fit inside the withdrawable
-- part, and the 50%-per-withdrawal rule applies to the withdrawable part.
-- Existing balances are NOT retro-locked: bonus_balance starts at 0 for
-- everyone; only rewards credited after this migration become locked.
-- Run in Supabase SQL editor (after 023).

-- ---------- columns ----------
alter table public.wallets
  add column if not exists bonus_balance numeric(12,2) not null default 0;
alter table public.wallets
  add column if not exists bonus_received numeric(12,2) not null default 0;
alter table public.wallets
  drop constraint if exists wallets_bonus_balance_nonneg;
alter table public.wallets
  add constraint wallets_bonus_balance_nonneg check (bonus_balance >= 0);

-- ---------- lock on reward credit / unlock on wagering ----------
create or replace function public.apply_bonus_flow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.type = 'bonus' and new.status = 'completed' then
    update public.wallets
      set bonus_balance  = bonus_balance + new.amount,
          bonus_received = bonus_received + new.amount,
          updated_at = now()
      where user_id = new.user_id;
  elsif new.type in ('stake','coinflip_bet','dragontiger_bet','andarbahar_bet',
                     'roulette_bet','cv_bet','dice_bet')
        and new.status in ('completed','approved') then
    update public.wallets
      set bonus_balance = least(greatest(bonus_balance - new.amount, 0), balance),
          updated_at = now()
      where user_id = new.user_id and bonus_balance > 0;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_apply_bonus_flow on public.transactions;
create trigger trg_apply_bonus_flow
  after insert on public.transactions
  for each row execute function public.apply_bonus_flow();

-- ---------- withdrawal gate: add bonus/withdrawable checks ----------
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
  v_bal numeric;
  v_bonus numeric;
  v_withdrawable numeric;
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
  -- 2. Bonus gate: locked bonus can never be withdrawn; the 50% rule
  --    applies to the withdrawable part (balance - locked bonus).
  select balance, bonus_balance into v_bal, v_bonus
    from public.wallets where user_id = new.user_id;
  v_withdrawable := greatest(0, coalesce(v_bal, 0) - coalesce(v_bonus, 0));
  if new.amount > v_withdrawable then
    raise exception 'Rs % of your balance is locked bonus — play to unlock it. Only Rs % is withdrawable right now.',
      to_char(coalesce(v_bonus, 0), 'FM999999990'), to_char(v_withdrawable, 'FM999999990');
  end if;
  if new.amount > floor(v_withdrawable * 0.5) then
    raise exception 'Max 50% of your withdrawable balance (Rs %) per withdrawal.',
      to_char(floor(v_withdrawable * 0.5), 'FM999999990');
  end if;
  -- 3. Turnover: total bets must be >= total approved deposits (1x)
  v_totals := public.payment_totals(new.user_id);
  if (v_totals ->> 'turnover')::numeric < (v_totals ->> 'deposits')::numeric then
    raise exception 'Turnover incomplete: you must play your full deposit amount before withdrawing.';
  end if;
  -- 4. Same-account rule: withdrawal must go to one of the user's saved accounts
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
-- (trigger trg_enforce_withdraw_rules from 023 already points at this function)
