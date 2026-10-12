-- Migration 011: Andar Bahar (multiplayer, 30-second rounds)
--
-- Game rules (user-specified):
--   * Two sides: ANDAR (inside) and BAHAR (outside). Players bet on a side.
--   * Rounds run 30 seconds, like Squad Stakes / Coin Flip.
--   * At settlement, the side with the LOWER total bid value WINS.
--   * Winners get DOUBLE (2x) their individual bet, paid from the losers' pool.
--   * The DIFFERENCE (losers' pool minus winners' payout) goes to the company
--     (fee_amount on ab_rounds — HIDDEN from clients, admin only).
--   * If losers' pool < winners' 2x, winners split the losers' pool
--     proportionally to their bets (fee = 0).
--   * SAME-SIDE RULE: all players on one side -> they ALL LOSE (no refund).
--     The empty side "wins" by default; company keeps everything.
--   * Exact tie -> round cancelled, all bids refunded.
--
-- Tables: ab_rounds, ab_bids, ab_round_stats (+ public_ab_rounds view).
-- RPCs: ab_get_current_round(), ab_place_bid(), ab_resolve_round(),
--       ab_resolve_due_rounds().
-- Ledger: 'andarbahar_bet' (stake), 'andarbahar_win' (payout).
-- Run in Supabase SQL Editor (project: winsquad).

-- ---------------------------------------------------------------------------
-- 1) Widen the transactions type check to include Andar Bahar types.
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
                 'coinflip_bet','coinflip_win',
                 'andarbahar_bet','andarbahar_win'));

-- ---------------------------------------------------------------------------
-- 2) Tables
-- ---------------------------------------------------------------------------
create table if not exists public.ab_rounds (
  id           uuid primary key default gen_random_uuid(),
  round_no     integer not null,
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz not null,
  status       text not null default 'open'
                 check (status in ('open','resolving','closed')),
  andar_total  numeric(12,2) not null default 0,
  bahar_total  numeric(12,2) not null default 0,
  player_count integer not null default 0,
  winning_side text check (winning_side in ('andar','bahar')),
  fee_amount   numeric(12,2) not null default 0, -- company cut, HIDDEN
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.ab_bids (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references public.ab_rounds(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  side       text not null check (side in ('andar','bahar')),
  amount     numeric(12,2) not null check (amount >= 10),
  is_winner  boolean,                 -- set at resolve; null = unresolved
  payout     numeric(12,2),           -- winner payout (0 for losers)
  refunded   boolean not null default false,
  placed_at  timestamptz not null default now(),
  unique (round_id, user_id)          -- one bet per user per round
);

-- Realtime-safe mirror of ab_rounds (no fee column). Maintained by triggers.
create table if not exists public.ab_round_stats (
  round_id     uuid primary key references public.ab_rounds(id) on delete cascade,
  round_no     integer not null,
  andar_total  numeric(12,2) not null default 0,
  bahar_total  numeric(12,2) not null default 0,
  player_count integer not null default 0,
  ends_at      timestamptz not null,
  status       text not null,
  winning_side text,
  updated_at   timestamptz not null default now()
);

create index if not exists idx_ab_bids_round on public.ab_bids (round_id);
create index if not exists idx_ab_rounds_status on public.ab_rounds (status, ends_at);

-- Public view (fee_amount excluded — never reaches clients).
create or replace view public.public_ab_rounds as
select id, round_no, starts_at, ends_at, status,
       andar_total, bahar_total, player_count, winning_side, created_at
from public.ab_rounds;

-- ---------------------------------------------------------------------------
-- 3) Triggers: ab_rounds -> ab_round_stats; ab_bids -> ab_rounds totals
-- ---------------------------------------------------------------------------
create or replace function public.sync_ab_round_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ab_round_stats
    (round_id, round_no, andar_total, bahar_total, player_count, ends_at, status, winning_side)
  values
    (new.id, new.round_no, new.andar_total, new.bahar_total, new.player_count,
     new.ends_at, new.status, new.winning_side)
  on conflict (round_id) do update set
    round_no     = excluded.round_no,
    andar_total  = excluded.andar_total,
    bahar_total  = excluded.bahar_total,
    player_count = excluded.player_count,
    ends_at      = excluded.ends_at,
    status       = excluded.status,
    winning_side = excluded.winning_side,
    updated_at   = now();
  return new;
end;
$$;

drop trigger if exists trg_ab_rounds_sync_stats on public.ab_rounds;
create trigger trg_ab_rounds_sync_stats
  after insert or update on public.ab_rounds
  for each row execute function public.sync_ab_round_stats();

create or replace function public.bump_ab_round_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ab_rounds
  set andar_total  = andar_total + case when new.side = 'andar' then new.amount else 0 end,
      bahar_total  = bahar_total + case when new.side = 'bahar' then new.amount else 0 end,
      player_count = player_count + 1,
      updated_at   = now()
  where id = new.round_id;
  return new;
end;
$$;

drop trigger if exists trg_ab_bids_bump_totals on public.ab_bids;
create trigger trg_ab_bids_bump_totals
  after insert on public.ab_bids
  for each row execute function public.bump_ab_round_totals();

-- ---------------------------------------------------------------------------
-- 4) Row Level Security
-- ---------------------------------------------------------------------------
alter table public.ab_rounds      enable row level security;
alter table public.ab_bids        enable row level security;
alter table public.ab_round_stats enable row level security;

-- ab_rounds: NO select policy (fee_amount hidden). Clients use public_ab_rounds.
-- ab_bids: users read ONLY their own bids (other players' sides stay hidden).
drop policy if exists "ab_bids_select_own" on public.ab_bids;
create policy "ab_bids_select_own"
  on public.ab_bids for select to authenticated
  using (auth.uid() = user_id);

-- ab_round_stats: public live data (totals per side, no money secrets).
drop policy if exists "ab_round_stats_select_all" on public.ab_round_stats;
create policy "ab_round_stats_select_all"
  on public.ab_round_stats for select to authenticated
  using (true);

grant select on public.public_ab_rounds to authenticated;
grant select on public.ab_round_stats   to authenticated;
grant select on public.ab_bids          to authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPCs
-- ---------------------------------------------------------------------------

-- Resolve due Andar Bahar rounds (called opportunistically).
create or replace function public.ab_resolve_due_rounds()
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
    select id from public.ab_rounds
    where status = 'open' and ends_at <= now()
    order by ends_at
    limit 20
  loop
    perform public.ab_resolve_round(v_id);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'resolved', v_count);
end;
$$;

-- Get (or create) the current open Andar Bahar round. Round numbers reset
-- to 1,2,3... at 12:00 AM PKT daily, like Squad Stakes / Coin Flip.
create or replace function public.ab_get_current_round()
returns public.public_ab_rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_round     public.public_ab_rounds%rowtype;
  v_today     date := (now() at time zone 'Asia/Karachi')::date;
  v_last_date date;
  v_next_no   integer;
begin
  perform public.ab_resolve_due_rounds();

  select id into v_id
  from public.ab_rounds
  where status = 'open'
  order by starts_at desc
  limit 1;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('winsquad_ab_current_round'));
    select id into v_id from public.ab_rounds where status = 'open' limit 1;
    if v_id is null then
      select (starts_at at time zone 'Asia/Karachi')::date into v_last_date
      from public.ab_rounds
      order by starts_at desc
      limit 1;

      if v_last_date is null or v_last_date < v_today then
        v_next_no := 1;
      else
        select coalesce(max(round_no), 0) + 1 into v_next_no
        from public.ab_rounds
        where (starts_at at time zone 'Asia/Karachi')::date = v_today;
      end if;

      insert into public.ab_rounds (round_no, starts_at, ends_at, status)
      values (v_next_no, now(), now() + interval '30 seconds', 'open')
      returning id into v_id;
    end if;
  end if;

  select * into v_round from public.public_ab_rounds where id = v_id;
  if v_round.id is null then
    raise exception 'andar bahar round vanished unexpectedly';
  end if;
  return v_round;
end;
$$;

-- Place a bet on andar/bahar in an Andar Bahar round.
create or replace function public.ab_place_bid(
  p_round_id uuid,
  p_side     text,
  p_amount   numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_side  text;
  v_round public.ab_rounds%rowtype;
  v_bid_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;

  v_side := lower(trim(coalesce(p_side, '')));
  if v_side not in ('andar', 'bahar') then
    return jsonb_build_object('ok', false, 'error', 'choose andar or bahar');
  end if;

  p_amount := round(p_amount, 2);
  if p_amount is null or p_amount < 10 then
    return jsonb_build_object('ok', false, 'error', 'minimum bet is Rs 10');
  end if;
  if p_amount > 100000 then
    return jsonb_build_object('ok', false, 'error', 'maximum bet is Rs 100,000');
  end if;

  perform public.ab_resolve_due_rounds();

  select * into v_round from public.ab_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' or v_round.ends_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'round is closed');
  end if;

  if exists (select 1 from public.ab_bids where round_id = p_round_id and user_id = v_uid) then
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
  values (v_uid, 'andarbahar_bet', p_amount, 'completed', 'wallet',
          'Andar Bahar round #' || v_round.round_no || ' · bet ' || upper(v_side));

  insert into public.ab_bids (round_id, user_id, side, amount)
  values (p_round_id, v_uid, v_side, p_amount)
  returning id into v_bid_id;
  -- ab_rounds totals are bumped by trg_ab_bids_bump_totals.

  return jsonb_build_object(
    'ok', true,
    'bid_id', v_bid_id,
    'side', v_side,
    'amount', p_amount,
    'round_no', v_round.round_no
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already bet this round');
end;
$$;

-- Settle an Andar Bahar round. IDEMPOTENT: no-op if already closed.
--   * SAME-SIDE RULE: all players on one side -> they ALL LOSE (no refund).
--     The empty side "wins" by default; company keeps everything.
--   * Exact tie -> round cancelled, all bids refunded.
--   * Otherwise the side with the LOWER total wins; winners get 2x their
--     bet from the losers' pool; the remainder is the (hidden) company fee.
--   * If losers' pool < 2x winners' total -> winners split the losers'
--     pool proportionally (fee = 0).
create or replace function public.ab_resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round   public.ab_rounds%rowtype;
  v_a       numeric(12,2);
  v_b       numeric(12,2);
  v_wside   text;
  v_wtotal  numeric(12,2);
  v_ltotal  numeric(12,2);
  v_fee     numeric(12,2) := 0;
  v_paid    numeric(12,2) := 0;
  v_payout  numeric(12,2);
  r         record;
begin
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;

  select * into v_round from public.ab_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' then
    return jsonb_build_object('ok', true, 'already_closed', true,
                              'winning_side', v_round.winning_side);
  end if;

  update public.ab_rounds set status = 'resolving', updated_at = now()
  where id = p_round_id;

  select coalesce(sum(amount) filter (where side = 'andar'), 0),
         coalesce(sum(amount) filter (where side = 'bahar'), 0)
  into v_a, v_b
  from public.ab_bids
  where round_id = p_round_id;

  -- SAME-SIDE RULE: all players on one side -> they ALL LOSE (money to company).
  -- No refund. The empty side "wins" by default.
  if v_a = 0 or v_b = 0 then
    update public.ab_bids
    set is_winner = false, payout = 0
    where round_id = p_round_id;

    v_fee := v_a + v_b; -- company keeps all

    update public.ab_rounds
    set status = 'closed',
        winning_side = case when v_a = 0 then 'bahar' else 'andar' end,
        fee_amount = v_fee,
        andar_total = v_a, bahar_total = v_b, updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'same_side_loss', true,
                              'winning_side', case when v_a = 0 then 'bahar' else 'andar' end,
                              'andar_total', v_a, 'bahar_total', v_b,
                              'fee', v_fee);
  end if;

  -- Exact tie -> refund everybody.
  if v_a = v_b then
    for r in select user_id, amount from public.ab_bids
             where round_id = p_round_id and not refunded
    loop
      update public.wallets
      set balance = balance + r.amount, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'payout', r.amount, 'completed', 'wallet',
              'Andar Bahar round #' || v_round.round_no || ' cancelled — bid refunded');
      update public.ab_bids
      set refunded = true, is_winner = false, payout = 0
      where round_id = p_round_id and user_id = r.user_id;
    end loop;

    update public.ab_rounds
    set status = 'closed', winning_side = null, fee_amount = 0,
        andar_total = v_a, bahar_total = v_b, updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'cancelled', true,
                              'andar_total', v_a, 'bahar_total', v_b);
  end if;

  -- Lower-total side wins.
  if v_a < v_b then
    v_wside := 'andar'; v_wtotal := v_a; v_ltotal := v_b;
  else
    v_wside := 'bahar'; v_wtotal := v_b; v_ltotal := v_a;
  end if;

  if v_ltotal >= 2 * v_wtotal then
    -- Full 2x payouts; company keeps the remainder.
    for r in select user_id, amount from public.ab_bids
             where round_id = p_round_id and side = v_wside
             order by placed_at
    loop
      v_payout := round(r.amount * 2, 2);
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'andarbahar_win', v_payout, 'completed', 'wallet',
              'Andar Bahar round #' || v_round.round_no || ' · ' ||
              upper(v_wside) || ' wins · 2x payout');
      update public.ab_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
    end loop;
    v_fee := v_ltotal - v_paid;
  else
    -- Pool too small for full 2x: winners split losers' pool proportionally.
    -- Truncate to paisa so the sum can never exceed the pool.
    for r in select user_id, amount from public.ab_bids
             where round_id = p_round_id and side = v_wside
             order by placed_at
    loop
      v_payout := floor(r.amount / v_wtotal * v_ltotal * 100) / 100;
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'andarbahar_win', v_payout, 'completed', 'wallet',
              'Andar Bahar round #' || v_round.round_no || ' · ' ||
              upper(v_wside) || ' wins · proportional payout');
      update public.ab_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
    end loop;
    v_fee := v_ltotal - v_paid;  -- >= 0 by truncation
  end if;

  -- Mark losers.
  update public.ab_bids
  set is_winner = false, payout = 0
  where round_id = p_round_id and side <> v_wside;

  update public.ab_rounds
  set status = 'closed', winning_side = v_wside, fee_amount = v_fee,
      andar_total = v_a, bahar_total = v_b, updated_at = now()
  where id = p_round_id;

  return jsonb_build_object('ok', true, 'cancelled', false,
                            'winning_side', v_wside,
                            'andar_total', v_a, 'bahar_total', v_b,
                            'winners_paid', v_paid);
end;
$$;

-- Re-apply the transactions select/insert grants (harmless if re-run).
grant select, insert on public.transactions to authenticated;
