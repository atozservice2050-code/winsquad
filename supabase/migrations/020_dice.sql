-- Migration 020: Dice / 7 Up Down (multiplayer, 15-second rounds)
--
-- Game concept (user-specified, official house rule):
--   * Two dice roll each round. Players pick ONE option per round:
--       UNDER 7  (dice total 2-6)
--       EXACTLY 7 (dice total exactly 7)
--       OVER 7   (dice total 8-12)
--   * Rounds run 15 seconds (like all games), round_no resets 1,2,3...
--     daily at 12:00 AM PKT.
--   * HOUSE RULE: the option with the LOWEST total bidding WINS.
--     The option with higher bidding LOSES. The company never takes a loss.
--   * The dice shown at settlement are DISPLAY-ONLY: they are picked so the
--     dice total falls inside the WINNING option's range (under7: 2-6,
--     seven: exactly 7, over7: 8-12). The winner is decided by bidding
--     totals, never by the dice.
--   * Winners get 1.9x their individual bet, paid from the losers' pool.
--     The DIFFERENCE (losers' pool minus winners' payout) is the company fee
--     (fee_amount on dice_rounds — HIDDEN from clients, admin only).
--   * If losers' pool < 1.9x winners' total -> winners split the losers'
--     pool proportionally to their bets (fee = 0).
--   * All real players on a single option -> they ALL LOSE (money to company),
--     same as the coin-flip same-side rule.
--   * Fewer than 3 bids -> round cancelled, all bids refunded.
--
-- Tables: dice_rounds, dice_bids, dice_round_stats (+ public_dice_rounds view).
-- RPCs: dice_get_current_round(), dice_place_bid(), dice_resolve_round(),
--       dice_resolve_due_rounds().
-- Ledger: 'dice_bet' (stake), 'dice_win' (payout), 'dice_loss' (lost stake).
-- Responsible gaming: reuses the rg_* helpers from migration 019.
-- Run in Supabase SQL Editor (project: winsquad). Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Widen the transactions type check to include dice types.
-- ---------------------------------------------------------------------------
do $$
declare
  v_con text;
begin
  select conname into v_con
  from pg_constraint
  where conrelid = 'public.transactions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%''deposit''%';
  if v_con is not null then
    execute format('alter table public.transactions drop constraint %I', v_con);
  end if;
end $$;

alter table public.transactions
  add constraint transactions_type_check
  check (type in ('deposit','withdraw','transfer_in','transfer_out',
                 'stake','payout','bonus','fee',
                 'coinflip_bet','coinflip_win','coinflip_loss',
                 'dragontiger_bet','dragontiger_win','dragontiger_loss',
                 'andarbahar_bet','andarbahar_win',
                 'roulette_bet','roulette_win','roulette_loss',
                 'squad_loss',
                 'cv_bet','cv_win','cv_loss',
                 'dice_bet','dice_win','dice_loss'));

-- ---------------------------------------------------------------------------
-- 2) Tables
-- ---------------------------------------------------------------------------
create table if not exists public.dice_rounds (
  id             uuid primary key default gen_random_uuid(),
  round_no       integer not null,
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz not null,
  status         text not null default 'open'
                   check (status in ('open','resolving','closed')),
  option_totals  jsonb not null default
                   '{"under7":0,"seven":0,"over7":0}'::jsonb,
  total_pool     numeric(12,2) not null default 0,
  player_count   integer not null default 0,
  winning_option text check (winning_option in
                   ('under7','seven','over7')),
  dice1          integer check (dice1 between 1 and 6),
  dice2          integer check (dice2 between 1 and 6),
  dice_total     integer check (dice_total between 2 and 12),
  fee_amount     numeric(12,2) not null default 0, -- company cut, HIDDEN
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.dice_bids (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references public.dice_rounds(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  option     text not null check (option in
               ('under7','seven','over7')),
  amount     numeric(12,2) not null check (amount >= 10),
  is_winner  boolean,                 -- set at resolve; null = unresolved
  payout     numeric(12,2),           -- winner payout (0 for losers)
  refunded   boolean not null default false,
  placed_at  timestamptz not null default now(),
  unique (round_id, user_id)          -- one bet per user per round
);

-- Realtime-safe mirror of dice_rounds (no fee column). Maintained by triggers.
create table if not exists public.dice_round_stats (
  round_id       uuid primary key references public.dice_rounds(id) on delete cascade,
  round_no       integer not null,
  option_totals  jsonb not null default
                   '{"under7":0,"seven":0,"over7":0}'::jsonb,
  player_count   integer not null default 0,
  ends_at        timestamptz not null,
  status         text not null,
  winning_option text,
  dice1          integer,
  dice2          integer,
  dice_total     integer,
  updated_at     timestamptz not null default now()
);

create index if not exists idx_dice_bids_round on public.dice_bids (round_id);
create index if not exists idx_dice_rounds_status on public.dice_rounds (status, ends_at);

-- Public view (fee_amount excluded — never reaches clients).
create or replace view public.public_dice_rounds as
select id, round_no, starts_at, ends_at, status,
       option_totals, total_pool, player_count, winning_option,
       dice1, dice2, dice_total, created_at
from public.dice_rounds;

-- ---------------------------------------------------------------------------
-- 3) Triggers: dice_rounds -> dice_round_stats; dice_bids -> dice_rounds totals
-- ---------------------------------------------------------------------------
create or replace function public.sync_dice_round_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.dice_round_stats
    (round_id, round_no, option_totals, player_count, ends_at, status,
     winning_option, dice1, dice2, dice_total)
  values
    (new.id, new.round_no, new.option_totals, new.player_count,
     new.ends_at, new.status, new.winning_option, new.dice1, new.dice2, new.dice_total)
  on conflict (round_id) do update set
    round_no       = excluded.round_no,
    option_totals  = excluded.option_totals,
    player_count   = excluded.player_count,
    ends_at        = excluded.ends_at,
    status         = excluded.status,
    winning_option = excluded.winning_option,
    dice1          = excluded.dice1,
    dice2          = excluded.dice2,
    dice_total     = excluded.dice_total,
    updated_at     = now();
  return new;
end;
$$;

drop trigger if exists trg_dice_rounds_sync_stats on public.dice_rounds;
create trigger trg_dice_rounds_sync_stats
  after insert or update on public.dice_rounds
  for each row execute function public.sync_dice_round_stats();

create or replace function public.bump_dice_round_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.dice_rounds
  set option_totals = jsonb_set(
        option_totals,
        array[new.option],
        to_jsonb(coalesce((option_totals ->> new.option)::numeric, 0) + new.amount)
      ),
      total_pool   = total_pool + new.amount,
      player_count = player_count + 1,
      updated_at   = now()
  where id = new.round_id;
  return new;
end;
$$;

drop trigger if exists trg_dice_bids_bump_totals on public.dice_bids;
create trigger trg_dice_bids_bump_totals
  after insert on public.dice_bids
  for each row execute function public.bump_dice_round_totals();

-- ---------------------------------------------------------------------------
-- 4) Row Level Security
-- ---------------------------------------------------------------------------
alter table public.dice_rounds      enable row level security;
alter table public.dice_bids        enable row level security;
alter table public.dice_round_stats enable row level security;

-- dice_rounds: NO select policy (fee_amount hidden). Clients use public_dice_rounds.
-- dice_bids: users read ONLY their own bids (other players' picks stay hidden).
drop policy if exists "dice_bids_select_own" on public.dice_bids;
create policy "dice_bids_select_own"
  on public.dice_bids for select to authenticated
  using (auth.uid() = user_id);

-- dice_round_stats: public live data (totals per option, no money secrets).
drop policy if exists "dice_round_stats_select_all" on public.dice_round_stats;
create policy "dice_round_stats_select_all"
  on public.dice_round_stats for select to authenticated
  using (true);

grant select on public.public_dice_rounds to authenticated;
grant select on public.dice_round_stats   to authenticated;
grant select on public.dice_bids          to authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPCs
-- ---------------------------------------------------------------------------

-- Resolve due dice rounds (called opportunistically).
create or replace function public.dice_resolve_due_rounds()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_count integer := 0;
begin
  for v_id in
    select id from public.dice_rounds
    where status = 'open' and ends_at <= now()
    order by ends_at
    limit 20
  loop
    perform public.dice_resolve_round(v_id);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'resolved', v_count);
end;
$$;

-- Get (or create) the current open dice round. 15-second rounds;
-- round numbers reset to 1,2,3... at 12:00 AM PKT daily, like all games.
create or replace function public.dice_get_current_round()
returns public.public_dice_rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_round     public.public_dice_rounds%rowtype;
  v_today     date := (now() at time zone 'Asia/Karachi')::date;
  v_last_date date;
  v_next_no   integer;
begin
  perform public.dice_resolve_due_rounds();

  select id into v_id
  from public.dice_rounds
  where status = 'open'
  order by starts_at desc
  limit 1;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('winsquad_dice_current_round'));
    select id into v_id from public.dice_rounds where status = 'open' limit 1;
    if v_id is null then
      select (starts_at at time zone 'Asia/Karachi')::date into v_last_date
      from public.dice_rounds
      order by starts_at desc
      limit 1;

      if v_last_date is null or v_last_date < v_today then
        v_next_no := 1;
      else
        select coalesce(max(round_no), 0) + 1 into v_next_no
        from public.dice_rounds
        where (starts_at at time zone 'Asia/Karachi')::date = v_today;
      end if;

      insert into public.dice_rounds (round_no, starts_at, ends_at, status)
      values (v_next_no, now(), now() + interval '15 seconds', 'open')
      returning id into v_id;
    end if;
  end if;

  select * into v_round from public.public_dice_rounds where id = v_id;
  if v_round.id is null then
    raise exception 'dice round vanished unexpectedly';
  end if;
  return v_round;
end;
$$;

-- Place a bet on a dice option in a dice round.
create or replace function public.dice_place_bid(
  p_round_id uuid,
  p_option   text,
  p_amount   numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_option  text;
  v_round   public.dice_rounds%rowtype;
  v_bid_id  uuid;
  v_cooldown_msg text;
  v_warning_msg  text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;

  -- Loss cool-down (responsible gaming): 15 straight losses -> 1h bid block.
  v_cooldown_msg := public.rg_bid_cooldown_message(v_uid);
  if v_cooldown_msg is not null then
    return jsonb_build_object('ok', false, 'error', 'cooldown',
                              'message', v_cooldown_msg);
  end if;

  -- Loss streak warning (10+ straight losses): non-blocking, shown as toast.
  v_warning_msg := public.rg_bid_warning_message(v_uid);

  v_option := lower(trim(coalesce(p_option, '')));
  if v_option not in ('under7','seven','over7') then
    return jsonb_build_object('ok', false, 'error', 'pick an option');
  end if;

  p_amount := round(p_amount, 2);
  if p_amount is null or p_amount < 10 then
    return jsonb_build_object('ok', false, 'error', 'minimum bet is Rs 10');
  end if;
  if p_amount > 100000 then
    return jsonb_build_object('ok', false, 'error', 'maximum bet is Rs 100,000');
  end if;

  perform public.dice_resolve_due_rounds();

  select * into v_round from public.dice_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' or v_round.ends_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'round is closed');
  end if;

  if exists (select 1 from public.dice_bids where round_id = p_round_id and user_id = v_uid) then
    return jsonb_build_object('ok', false, 'error', 'already bet this round');
  end if;

  -- atomic debit; fails cleanly on insufficient balance
  update public.wallets
  set balance = balance - p_amount, updated_at = now()
  where user_id = v_uid and balance >= p_amount;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'insufficient balance');
  end if;

  insert into public.transactions (user_id, type, amount, status, method, note)
  values (v_uid, 'dice_bet', p_amount, 'completed', 'wallet',
          'Dice round #' || v_round.round_no || ' · bet ' || upper(v_option));

  insert into public.dice_bids (round_id, user_id, option, amount)
  values (p_round_id, v_uid, v_option, p_amount)
  returning id into v_bid_id;
  -- dice_rounds totals are bumped by trg_dice_bids_bump_totals.

  return jsonb_build_object(
    'ok', true,
    'bid_id', v_bid_id,
    'option', v_option,
    'amount', p_amount,
    'round_no', v_round.round_no,
    'warning', v_warning_msg
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already bet this round');
end;
$$;

-- Settle a dice round. IDEMPOTENT: no-op if already closed.
--   * the option with the LOWEST total bidding WINS (house rule);
--     winners get 1.9x their bet from the losers' pool; the remainder is
--     the (hidden) company fee. The company never takes a loss.
--   * the displayed dice are picked so the dice total falls inside the
--     WINNING option's range (display only — the winner was decided by
--     bidding totals).
--   * if losers' pool < 1.9x winners' total -> winners split the losers'
--     pool proportionally (fee = 0).
--   * all bids on a single option -> everybody LOSES (money to company).
--   * fewer than 3 bids -> round cancelled, all bids refunded.
create or replace function public.dice_resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round     public.dice_rounds%rowtype;
  v_bid_count integer;
  v_wopt      text;          -- winning option
  v_wtotal    numeric(12,2); -- winners' total
  v_ltotal    numeric(12,2); -- losers' total
  v_fee       numeric(12,2) := 0;
  v_paid      numeric(12,2) := 0;
  v_payout    numeric(12,2);
  v_mult      numeric(4,2);       -- payout multiplier (2x or 5x)
  v_d1        integer;       -- display dice
  v_d2        integer;
  v_dtotal    integer;
  r           record;
begin
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;

  select * into v_round from public.dice_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' then
    return jsonb_build_object('ok', true, 'already_closed', true,
                              'winning_option', v_round.winning_option);
  end if;

  update public.dice_rounds set status = 'resolving', updated_at = now()
  where id = p_round_id;

  select count(*) into v_bid_count
  from public.dice_bids
  where round_id = p_round_id;

  -- Cancel: fewer than 3 bids -> refund everybody.
  if v_bid_count < 3 then
    for r in select user_id, amount from public.dice_bids
             where round_id = p_round_id and not refunded
    loop
      update public.wallets
      set balance = balance + r.amount, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'payout', r.amount, 'completed', 'wallet',
              'Dice round #' || v_round.round_no || ' cancelled — bid refunded');
      update public.dice_bids
      set refunded = true, is_winner = false, payout = 0
      where round_id = p_round_id and user_id = r.user_id;
    end loop;

    update public.dice_rounds
    set status = 'closed', winning_option = null, fee_amount = 0,
        total_pool = (select coalesce(sum(amount), 0) from public.dice_bids
                      where round_id = p_round_id),
        updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'cancelled', true,
                              'bid_count', v_bid_count);
  end if;

  -- Find the option(s) that actually have bids.
  -- SINGLE-OPTION RULE: all players on one option -> they ALL LOSE
  -- (money to company). No refund.
  if (select count(*) from
        (select 1 from public.dice_bids where round_id = p_round_id
         group by option) s) = 1 then
    select option into v_wopt from public.dice_bids
    where round_id = p_round_id limit 1;

    update public.dice_bids
    set is_winner = false, payout = 0
    where round_id = p_round_id;

    -- LOSS LEDGER: single-option losers get explicit transaction rows.
    for r in select user_id, amount from public.dice_bids
             where round_id = p_round_id
    loop
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'dice_loss', r.amount, 'completed', 'wallet',
              'Dice round #' || v_round.round_no ||
              ' - all players on one option - lost Rs ' || r.amount::text);
      perform public.rg_record_result(r.user_id, false);
    end loop;

    v_fee := (select coalesce(sum(amount), 0) from public.dice_bids
              where round_id = p_round_id); -- company keeps all

    -- Display dice matching the (losing) option's range.
    if v_wopt = 'under7' then
      v_d1 := 1 + floor(random()*3)::int; v_d2 := 1 + floor(random()*3)::int;
    elsif v_wopt = 'seven' then
      v_d1 := 1 + floor(random()*6)::int; v_d2 := 7 - v_d1;
    else
      v_d1 := 4 + floor(random()*3)::int; v_d2 := 4 + floor(random()*3)::int;
    end if;
    v_dtotal := v_d1 + v_d2;

    update public.dice_rounds
    set status = 'closed', winning_option = v_wopt,
        dice1 = v_d1, dice2 = v_d2, dice_total = v_dtotal,
        fee_amount = v_fee,
        total_pool = v_fee, updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'single_option_loss', true,
                              'fee', v_fee, 'bid_count', v_bid_count,
                              'dice1', v_d1, 'dice2', v_d2, 'dice_total', v_dtotal);
  end if;

  -- Lowest-total option WITH bids wins.
  select option, total into v_wopt, v_wtotal
  from (select option, coalesce(sum(amount), 0) as total
        from public.dice_bids
        where round_id = p_round_id
        group by option) t
  order by total asc
  limit 1;

  select coalesce(sum(amount), 0) into v_ltotal
  from public.dice_bids
  where round_id = p_round_id and option <> v_wopt;

  -- Display dice picked so the total falls inside the WINNING option's range.
  -- (Display only — the winner was decided by bidding totals above.)
  if v_wopt = 'under7' then
    v_d1 := 1 + floor(random()*3)::int; v_d2 := 1 + floor(random()*3)::int; -- total 2-6
  elsif v_wopt = 'seven' then
    v_d1 := 1 + floor(random()*6)::int; v_d2 := 7 - v_d1;                    -- total exactly 7
  else -- 'over7'
    v_d1 := 4 + floor(random()*3)::int; v_d2 := 4 + floor(random()*3)::int;  -- total 8-12
  end if;
  v_dtotal := v_d1 + v_d2;

  -- Variable payout: under7=2x, seven=5x, over7=2x (user-approved, NOT flat)
  v_mult := case v_wopt when 'seven' then 5.0 else 2.0 end;

  if v_ltotal >= v_mult * v_wtotal then
    -- Full payouts; company keeps the remainder.
    for r in select user_id, amount from public.dice_bids
             where round_id = p_round_id and option = v_wopt
             order by placed_at
    loop
      v_payout := round(r.amount * v_mult, 2);
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'dice_win', v_payout, 'completed', 'wallet',
              'Dice round #' || v_round.round_no || ' · ' ||
              upper(v_wopt) || ' wins · ' || v_mult::text || 'x payout');
      update public.dice_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
      perform public.rg_record_result(r.user_id, true);
    end loop;
    v_fee := v_ltotal - v_paid;
  else
    -- Pool too small for full 1.9x: winners split losers' pool proportionally.
    -- Truncate to paisa so the sum can never exceed the pool.
    for r in select user_id, amount from public.dice_bids
             where round_id = p_round_id and option = v_wopt
             order by placed_at
    loop
      v_payout := floor(r.amount / v_wtotal * v_ltotal * 100) / 100;
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'dice_win', v_payout, 'completed', 'wallet',
              'Dice round #' || v_round.round_no || ' · ' ||
              upper(v_wopt) || ' wins · proportional payout');
      update public.dice_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
      perform public.rg_record_result(r.user_id, true);
    end loop;
    v_fee := v_ltotal - v_paid;  -- >= 0 by truncation
  end if;

  -- Mark losers and write LOSS LEDGER rows.
  for r in select user_id, amount from public.dice_bids
           where round_id = p_round_id and option <> v_wopt
  loop
    insert into public.transactions (user_id, type, amount, status, method, note)
    values (r.user_id, 'dice_loss', r.amount, 'completed', 'wallet',
            'Dice round #' || v_round.round_no ||
            ' - lost Rs ' || r.amount::text);
    perform public.rg_record_result(r.user_id, false);
  end loop;

  update public.dice_bids
  set is_winner = false, payout = 0
  where round_id = p_round_id and option <> v_wopt;

  update public.dice_rounds
  set status = 'closed', winning_option = v_wopt,
      dice1 = v_d1, dice2 = v_d2, dice_total = v_dtotal,
      fee_amount = v_fee,
      total_pool = v_wtotal + v_ltotal, updated_at = now()
  where id = p_round_id;

  return jsonb_build_object('ok', true, 'cancelled', false,
                            'winning_option', v_wopt,
                            'winners_total', v_wtotal, 'losers_total', v_ltotal,
                            'winners_paid', v_paid,
                            'bid_count', v_bid_count,
                            'dice1', v_d1, 'dice2', v_d2, 'dice_total', v_dtotal);
end;
$$;

-- Re-apply the transactions select/insert grants (harmless if re-run).
grant select, insert on public.transactions to authenticated;
