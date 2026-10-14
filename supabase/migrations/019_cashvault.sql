-- Migration 019: Cash Vault (multiplayer money-wheel, 15-second rounds)
--
-- Game rules (user-specified, official house rule):
--   * A spinning wheel has 6 vault segments: RED, BLUE, GOLD, GREEN, PURPLE, SILVER.
--   * Players pick ONE segment and bet on it each round.
--   * Rounds run 15 seconds (like all games), round_no resets 1,2,3... daily at 12:00 AM PKT.
--   * HOUSE RULE: the segment with the LOWEST total bidding WINS.
--     The segment with higher bidding LOSES. The company never takes a loss.
--   * Winners get 1.9x their individual bet, paid from the losers' pool.
--     The DIFFERENCE (losers' pool minus winners' payout) is the company fee
--     (fee_amount on cv_rounds — HIDDEN from clients, admin only).
--   * If losers' pool < 1.9x winners' total -> winners split the losers' pool
--     proportionally to their bets (fee = 0).
--   * All real players on a single segment -> they ALL LOSE (money to company),
--     same as the coin-flip same-side rule.
--   * Fewer than 3 bids -> round cancelled, all bids refunded.
--
-- Tables: cv_rounds, cv_bids, cv_round_stats (+ public_cv_rounds view).
-- RPCs: cv_get_current_round(), cv_place_bid(), cv_resolve_round(),
--       cv_resolve_due_rounds().
-- Ledger: 'cv_bet' (stake), 'cv_win' (payout), 'cv_loss' (lost stake).
-- Run in Supabase SQL Editor (project: winsquad). Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Widen the transactions type check to include cash-vault types
--    (and the *_loss types from 018, which were never added to the check).
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
                 'cv_bet','cv_win','cv_loss'));

-- ---------------------------------------------------------------------------
-- 1b) Responsible gaming: loss streak columns + reusable helpers.
--     Rule: 10 consecutive losses -> WARNING ("Play carefully!").
--           15 consecutive losses -> cannot bid in ANY game for 1 hour.
--           Any WIN resets the streak to 0.
--     Other games (coinflip, dragontiger, roulette, squad) adopt this later
--     by calling these same functions — no schema changes needed there.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists consecutive_losses integer not null default 0,
  add column if not exists cooldown_until timestamptz;

-- Returns the cool-down (block) message if the user is currently blocked, else NULL.
create or replace function public.rg_bid_cooldown_message(p_uid uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_until timestamptz;
begin
  if p_uid is null then return null; end if;
  select cooldown_until into v_until from public.profiles where id = p_uid;
  if v_until is not null and v_until > now() then
    return 'For your protection, betting is paused for 1 hour following 15 consecutive losses. Please take a break and return refreshed. Better luck next time!';
  end if;
  return null;
end;
$$;

-- Returns the warning message if the user is on a 10+ loss streak
-- (but not yet blocked), else NULL. Shown as a non-blocking toast.
create or replace function public.rg_bid_warning_message(p_uid uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_streak  integer;
  v_until   timestamptz;
begin
  if p_uid is null then return null; end if;
  select consecutive_losses, cooldown_until
    into v_streak, v_until
  from public.profiles where id = p_uid;
  if v_streak is null then return null; end if;
  if v_until is not null and v_until > now() then return null; end if; -- blocked: block msg wins
  if v_streak >= 10 then
    return 'You have reached 10 consecutive losses. We strongly recommend taking a break and reviewing your strategy. Please play responsibly.';
  end if;
  return null;
end;
$$;

-- Record one settled game result for responsible-gaming tracking.
-- Winner: streak resets to 0. Loser: streak +1; at 15 -> 1-hour cool-down
-- and the streak resets (a fresh count starts after the cool-down).
create or replace function public.rg_record_result(p_uid uuid, p_won boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_uid is null then return; end if;
  if p_won then
    update public.profiles
    set consecutive_losses = 0
    where id = p_uid;
  else
    -- All right-hand expressions see the OLD row, so consecutive_losses + 1
    -- is the pre-update value in both branches. Correct as written.
    update public.profiles
    set consecutive_losses = case when consecutive_losses + 1 >= 15 then 0
                                  else consecutive_losses + 1 end,
        cooldown_until     = case when consecutive_losses + 1 >= 15
                                  then now() + interval '1 hour'
                                  else cooldown_until end
    where id = p_uid;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Tables
-- ---------------------------------------------------------------------------
create table if not exists public.cv_rounds (
  id             uuid primary key default gen_random_uuid(),
  round_no       integer not null,
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz not null,
  status         text not null default 'open'
                   check (status in ('open','resolving','closed')),
  seg_totals     jsonb not null default
                   '{"red":0,"blue":0,"gold":0,"green":0,"purple":0,"silver":0}'::jsonb,
  total_pool     numeric(12,2) not null default 0,
  player_count   integer not null default 0,
  winning_segment text check (winning_segment in
                   ('red','blue','gold','green','purple','silver')),
  fee_amount     numeric(12,2) not null default 0, -- company cut, HIDDEN
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.cv_bids (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references public.cv_rounds(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  segment    text not null check (segment in
               ('red','blue','gold','green','purple','silver')),
  amount     numeric(12,2) not null check (amount >= 10),
  is_winner  boolean,                 -- set at resolve; null = unresolved
  payout     numeric(12,2),           -- winner payout (0 for losers)
  refunded   boolean not null default false,
  placed_at  timestamptz not null default now(),
  unique (round_id, user_id)          -- one bet per user per round
);

-- Realtime-safe mirror of cv_rounds (no fee column). Maintained by triggers.
create table if not exists public.cv_round_stats (
  round_id        uuid primary key references public.cv_rounds(id) on delete cascade,
  round_no        integer not null,
  segment_totals  jsonb not null default
                    '{"red":0,"blue":0,"gold":0,"green":0,"purple":0,"silver":0}'::jsonb,
  player_count    integer not null default 0,
  ends_at         timestamptz not null,
  status          text not null,
  winning_segment text,
  updated_at      timestamptz not null default now()
);

create index if not exists idx_cv_bids_round on public.cv_bids (round_id);
create index if not exists idx_cv_rounds_status on public.cv_rounds (status, ends_at);

-- Public view (fee_amount excluded — never reaches clients).
create or replace view public.public_cv_rounds as
select id, round_no, starts_at, ends_at, status,
       seg_totals, total_pool, player_count, winning_segment, created_at
from public.cv_rounds;

-- ---------------------------------------------------------------------------
-- 3) Triggers: cv_rounds -> cv_round_stats; cv_bids -> cv_rounds totals
-- ---------------------------------------------------------------------------
create or replace function public.sync_cv_round_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.cv_round_stats
    (round_id, round_no, segment_totals, player_count, ends_at, status, winning_segment)
  values
    (new.id, new.round_no, new.seg_totals, new.player_count,
     new.ends_at, new.status, new.winning_segment)
  on conflict (round_id) do update set
    round_no        = excluded.round_no,
    segment_totals  = excluded.segment_totals,
    player_count    = excluded.player_count,
    ends_at         = excluded.ends_at,
    status          = excluded.status,
    winning_segment = excluded.winning_segment,
    updated_at      = now();
  return new;
end;
$$;

drop trigger if exists trg_cv_rounds_sync_stats on public.cv_rounds;
create trigger trg_cv_rounds_sync_stats
  after insert or update on public.cv_rounds
  for each row execute function public.sync_cv_round_stats();

create or replace function public.bump_cv_round_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.cv_rounds
  set seg_totals = jsonb_set(
        seg_totals,
        array[new.segment],
        to_jsonb(coalesce((seg_totals ->> new.segment)::numeric, 0) + new.amount)
      ),
      total_pool   = total_pool + new.amount,
      player_count = player_count + 1,
      updated_at   = now()
  where id = new.round_id;
  return new;
end;
$$;

drop trigger if exists trg_cv_bids_bump_totals on public.cv_bids;
create trigger trg_cv_bids_bump_totals
  after insert on public.cv_bids
  for each row execute function public.bump_cv_round_totals();

-- ---------------------------------------------------------------------------
-- 4) Row Level Security
-- ---------------------------------------------------------------------------
alter table public.cv_rounds      enable row level security;
alter table public.cv_bids        enable row level security;
alter table public.cv_round_stats enable row level security;

-- cv_rounds: NO select policy (fee_amount hidden). Clients use public_cv_rounds.
-- cv_bids: users read ONLY their own bids (other players' picks stay hidden).
drop policy if exists "cv_bids_select_own" on public.cv_bids;
create policy "cv_bids_select_own"
  on public.cv_bids for select to authenticated
  using (auth.uid() = user_id);

-- cv_round_stats: public live data (totals per segment, no money secrets).
drop policy if exists "cv_round_stats_select_all" on public.cv_round_stats;
create policy "cv_round_stats_select_all"
  on public.cv_round_stats for select to authenticated
  using (true);

grant select on public.public_cv_rounds to authenticated;
grant select on public.cv_round_stats   to authenticated;
grant select on public.cv_bids          to authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPCs
-- ---------------------------------------------------------------------------

-- Resolve due cash-vault rounds (called opportunistically).
create or replace function public.cv_resolve_due_rounds()
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
    select id from public.cv_rounds
    where status = 'open' and ends_at <= now()
    order by ends_at
    limit 20
  loop
    perform public.cv_resolve_round(v_id);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'resolved', v_count);
end;
$$;

-- Get (or create) the current open cash-vault round. 15-second rounds;
-- round numbers reset to 1,2,3... at 12:00 AM PKT daily, like all games.
create or replace function public.cv_get_current_round()
returns public.public_cv_rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_round     public.public_cv_rounds%rowtype;
  v_today     date := (now() at time zone 'Asia/Karachi')::date;
  v_last_date date;
  v_next_no   integer;
begin
  perform public.cv_resolve_due_rounds();

  select id into v_id
  from public.cv_rounds
  where status = 'open'
  order by starts_at desc
  limit 1;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('winsquad_cv_current_round'));
    select id into v_id from public.cv_rounds where status = 'open' limit 1;
    if v_id is null then
      select (starts_at at time zone 'Asia/Karachi')::date into v_last_date
      from public.cv_rounds
      order by starts_at desc
      limit 1;

      if v_last_date is null or v_last_date < v_today then
        v_next_no := 1;
      else
        select coalesce(max(round_no), 0) + 1 into v_next_no
        from public.cv_rounds
        where (starts_at at time zone 'Asia/Karachi')::date = v_today;
      end if;

      insert into public.cv_rounds (round_no, starts_at, ends_at, status)
      values (v_next_no, now(), now() + interval '15 seconds', 'open')
      returning id into v_id;
    end if;
  end if;

  select * into v_round from public.public_cv_rounds where id = v_id;
  if v_round.id is null then
    raise exception 'cash vault round vanished unexpectedly';
  end if;
  return v_round;
end;
$$;

-- Place a bet on a vault segment in a cash-vault round.
create or replace function public.cv_place_bid(
  p_round_id uuid,
  p_segment  text,
  p_amount   numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_segment text;
  v_round   public.cv_rounds%rowtype;
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

  v_segment := lower(trim(coalesce(p_segment, '')));
  if v_segment not in ('red','blue','gold','green','purple','silver') then
    return jsonb_build_object('ok', false, 'error', 'pick a vault segment');
  end if;

  p_amount := round(p_amount, 2);
  if p_amount is null or p_amount < 10 then
    return jsonb_build_object('ok', false, 'error', 'minimum bet is Rs 10');
  end if;
  if p_amount > 100000 then
    return jsonb_build_object('ok', false, 'error', 'maximum bet is Rs 100,000');
  end if;

  perform public.cv_resolve_due_rounds();

  select * into v_round from public.cv_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' or v_round.ends_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'round is closed');
  end if;

  if exists (select 1 from public.cv_bids where round_id = p_round_id and user_id = v_uid) then
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
  values (v_uid, 'cv_bet', p_amount, 'completed', 'wallet',
          'Cash Vault round #' || v_round.round_no || ' · bet ' || upper(v_segment));

  insert into public.cv_bids (round_id, user_id, segment, amount)
  values (p_round_id, v_uid, v_segment, p_amount)
  returning id into v_bid_id;
  -- cv_rounds totals are bumped by trg_cv_bids_bump_totals.

  return jsonb_build_object(
    'ok', true,
    'bid_id', v_bid_id,
    'segment', v_segment,
    'amount', p_amount,
    'round_no', v_round.round_no,
    'warning', v_warning_msg
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already bet this round');
end;
$$;

-- Settle a cash-vault round. IDEMPOTENT: no-op if already closed.
--   * the segment with the LOWEST total bidding WINS (house rule);
--     winners get 1.9x their bet from the losers' pool; the remainder is
--     the (hidden) company fee. The company never takes a loss.
--   * if losers' pool < 1.9x winners' total -> winners split the losers'
--     pool proportionally (fee = 0).
--   * all bids on a single segment -> everybody LOSES (money to company).
--   * fewer than 3 bids -> round cancelled, all bids refunded.
create or replace function public.cv_resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round     public.cv_rounds%rowtype;
  v_bid_count integer;
  v_wseg      text;          -- winning segment
  v_wtotal    numeric(12,2); -- winners' total
  v_ltotal    numeric(12,2); -- losers' total
  v_fee       numeric(12,2) := 0;
  v_paid      numeric(12,2) := 0;
  v_payout    numeric(12,2);
  r           record;
begin
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;

  select * into v_round from public.cv_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' then
    return jsonb_build_object('ok', true, 'already_closed', true,
                              'winning_segment', v_round.winning_segment);
  end if;

  update public.cv_rounds set status = 'resolving', updated_at = now()
  where id = p_round_id;

  -- Totals per segment are computed via GROUP BY below
  -- (segments with no bids simply don't appear).

  select count(*) into v_bid_count
  from public.cv_bids
  where round_id = p_round_id;

  -- Cancel: fewer than 3 bids -> refund everybody.
  if v_bid_count < 3 then
    for r in select user_id, amount from public.cv_bids
             where round_id = p_round_id and not refunded
    loop
      update public.wallets
      set balance = balance + r.amount, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'payout', r.amount, 'completed', 'wallet',
              'Cash Vault round #' || v_round.round_no || ' cancelled — bid refunded');
      update public.cv_bids
      set refunded = true, is_winner = false, payout = 0
      where round_id = p_round_id and user_id = r.user_id;
    end loop;

    update public.cv_rounds
    set status = 'closed', winning_segment = null, fee_amount = 0,
        total_pool = (select coalesce(sum(amount), 0) from public.cv_bids
                      where round_id = p_round_id),
        updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'cancelled', true,
                              'bid_count', v_bid_count);
  end if;

  -- Find the segment(s) that actually have bids.
  -- SINGLE-SEGMENT RULE: all players on one segment -> they ALL LOSE
  -- (money to company). No refund.
  if (select count(*) from
        (select 1 from public.cv_bids where round_id = p_round_id
         group by segment) s) = 1 then
    update public.cv_bids
    set is_winner = false, payout = 0
    where round_id = p_round_id;

    -- LOSS LEDGER: single-segment losers get explicit transaction rows.
    for r in select user_id, amount from public.cv_bids
             where round_id = p_round_id
    loop
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'cv_loss', r.amount, 'completed', 'wallet',
              'Cash Vault round #' || v_round.round_no ||
              ' - all players on one segment - lost Rs ' || r.amount::text);
      perform public.rg_record_result(r.user_id, false);
    end loop;

    v_fee := (select coalesce(sum(amount), 0) from public.cv_bids
              where round_id = p_round_id); -- company keeps all

    update public.cv_rounds
    set status = 'closed',
        winning_segment = (select segment from public.cv_bids
                           where round_id = p_round_id limit 1),
        fee_amount = v_fee,
        total_pool = v_fee, updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'single_segment_loss', true,
                              'fee', v_fee, 'bid_count', v_bid_count);
  end if;

  -- Lowest-total segment WITH bids wins.
  select segment, total into v_wseg, v_wtotal
  from (select segment, coalesce(sum(amount), 0) as total
        from public.cv_bids
        where round_id = p_round_id
        group by segment) t
  order by total asc
  limit 1;

  select coalesce(sum(amount), 0) into v_ltotal
  from public.cv_bids
  where round_id = p_round_id and segment <> v_wseg;

  if v_ltotal >= 1.9 * v_wtotal then
    -- Full 1.9x payouts; company keeps the remainder.
    for r in select user_id, amount from public.cv_bids
             where round_id = p_round_id and segment = v_wseg
             order by placed_at
    loop
      v_payout := round(r.amount * 1.9, 2);
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'cv_win', v_payout, 'completed', 'wallet',
              'Cash Vault round #' || v_round.round_no || ' · ' ||
              upper(v_wseg) || ' wins · 1.9x payout');
      update public.cv_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
      perform public.rg_record_result(r.user_id, true);
    end loop;
    v_fee := v_ltotal - v_paid;
  else
    -- Pool too small for full 1.9x: winners split losers' pool proportionally.
    -- Truncate to paisa so the sum can never exceed the pool.
    for r in select user_id, amount from public.cv_bids
             where round_id = p_round_id and segment = v_wseg
             order by placed_at
    loop
      v_payout := floor(r.amount / v_wtotal * v_ltotal * 100) / 100;
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'cv_win', v_payout, 'completed', 'wallet',
              'Cash Vault round #' || v_round.round_no || ' · ' ||
              upper(v_wseg) || ' wins · proportional payout');
      update public.cv_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
      perform public.rg_record_result(r.user_id, true);
    end loop;
    v_fee := v_ltotal - v_paid;  -- >= 0 by truncation
  end if;

  -- Mark losers and write LOSS LEDGER rows.
  for r in select user_id, amount from public.cv_bids
           where round_id = p_round_id and segment <> v_wseg
  loop
    insert into public.transactions (user_id, type, amount, status, method, note)
    values (r.user_id, 'cv_loss', r.amount, 'completed', 'wallet',
            'Cash Vault round #' || v_round.round_no ||
            ' - lost Rs ' || r.amount::text);
    perform public.rg_record_result(r.user_id, false);
  end loop;

  update public.cv_bids
  set is_winner = false, payout = 0
  where round_id = p_round_id and segment <> v_wseg;

  update public.cv_rounds
  set status = 'closed', winning_segment = v_wseg, fee_amount = v_fee,
      total_pool = v_wtotal + v_ltotal, updated_at = now()
  where id = p_round_id;

  return jsonb_build_object('ok', true, 'cancelled', false,
                            'winning_segment', v_wseg,
                            'winners_total', v_wtotal, 'losers_total', v_ltotal,
                            'winners_paid', v_paid,
                            'bid_count', v_bid_count);
end;
$$;

-- Re-apply the transactions select/insert grants (harmless if re-run).
grant select, insert on public.transactions to authenticated;
