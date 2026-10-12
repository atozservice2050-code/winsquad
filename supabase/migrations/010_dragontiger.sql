-- Migration 010: Dragon Tiger (multiplayer, 30-second rounds)
--
-- Game rules (user-specified):
--   * Two sides: DRAGON and TIGER. Players bet on a side each round.
--   * Rounds run 30 seconds, like Squad Stakes / Coin Flip.
--   * At settlement, one card is dealt to each side (Ace=1 ... K=13).
--   * WinSquad formula (like Coin Flip): the side with the LOWER total bid
--     value WINS. Winners get DOUBLE (2x) their individual bet, paid from the
--     losers' pool. The DIFFERENCE goes to the company (fee_amount — HIDDEN).
--   * The card reveal is visual drama: the winning side is always dealt the
--     higher card, so the reveal matches the outcome.
--   * If losers' pool < winners' 2x, winners split the losers' pool
--     proportionally to their bets (fee = 0).
--   * SAME-SIDE RULE: all real players on one side -> they ALL LOSE,
--     money to company (no refund). The empty side "wins" by default.
--   * Exact tie on totals -> round cancelled, all bids refunded.
--
-- Tables: dt_rounds, dt_bids, dt_round_stats (+ public_dt_rounds view).
-- RPCs: dt_get_current_round(), dt_place_bid(), dt_resolve_round(),
--       dt_resolve_due_rounds().
-- Ledger: 'dragontiger_bet' (stake), 'dragontiger_win' (payout).
-- Run in Supabase SQL Editor (project: winsquad).

-- ---------------------------------------------------------------------------
-- 1) Widen the transactions type check to include dragon-tiger types.
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
                 'dragontiger_bet','dragontiger_win'));

-- ---------------------------------------------------------------------------
-- 2) Tables
-- ---------------------------------------------------------------------------
create table if not exists public.dt_rounds (
  id           uuid primary key default gen_random_uuid(),
  round_no     integer not null,
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz not null,
  status       text not null default 'open'
                 check (status in ('open','resolving','closed')),
  dragon_total numeric(12,2) not null default 0,
  tiger_total  numeric(12,2) not null default 0,
  player_count integer not null default 0,
  winning_side text check (winning_side in ('dragon','tiger')),
  dragon_card  text,                    -- e.g. 'K♠' (visual reveal)
  tiger_card   text,                    -- e.g. '7♥'  (visual reveal)
  fee_amount   numeric(12,2) not null default 0, -- company cut, HIDDEN
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.dt_bids (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references public.dt_rounds(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  side       text not null check (side in ('dragon','tiger')),
  amount     numeric(12,2) not null check (amount >= 10),
  is_winner  boolean,                 -- set at resolve; null = unresolved
  payout     numeric(12,2),           -- winner payout (0 for losers)
  refunded   boolean not null default false,
  placed_at  timestamptz not null default now(),
  unique (round_id, user_id)          -- one bet per user per round
);

-- Realtime-safe mirror of dt_rounds (no fee column). Maintained by triggers.
create table if not exists public.dt_round_stats (
  round_id     uuid primary key references public.dt_rounds(id) on delete cascade,
  round_no     integer not null,
  dragon_total numeric(12,2) not null default 0,
  tiger_total  numeric(12,2) not null default 0,
  player_count integer not null default 0,
  ends_at      timestamptz not null,
  status       text not null,
  winning_side text,
  dragon_card  text,
  tiger_card   text,
  updated_at   timestamptz not null default now()
);

create index if not exists idx_dt_bids_round on public.dt_bids (round_id);
create index if not exists idx_dt_rounds_status on public.dt_rounds (status, ends_at);

-- Public view (fee_amount excluded — never reaches clients).
create or replace view public.public_dt_rounds as
select id, round_no, starts_at, ends_at, status,
       dragon_total, tiger_total, player_count, winning_side,
       dragon_card, tiger_card, created_at
from public.dt_rounds;

-- ---------------------------------------------------------------------------
-- 3) Triggers: dt_rounds -> dt_round_stats; dt_bids -> dt_rounds totals
-- ---------------------------------------------------------------------------
create or replace function public.sync_dt_round_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.dt_round_stats
    (round_id, round_no, dragon_total, tiger_total, player_count, ends_at,
     status, winning_side, dragon_card, tiger_card)
  values
    (new.id, new.round_no, new.dragon_total, new.tiger_total, new.player_count,
     new.ends_at, new.status, new.winning_side, new.dragon_card, new.tiger_card)
  on conflict (round_id) do update set
    round_no     = excluded.round_no,
    dragon_total = excluded.dragon_total,
    tiger_total  = excluded.tiger_total,
    player_count = excluded.player_count,
    ends_at      = excluded.ends_at,
    status       = excluded.status,
    winning_side = excluded.winning_side,
    dragon_card  = excluded.dragon_card,
    tiger_card   = excluded.tiger_card,
    updated_at   = now();
  return new;
end;
$$;

drop trigger if exists trg_dt_rounds_sync_stats on public.dt_rounds;
create trigger trg_dt_rounds_sync_stats
  after insert or update on public.dt_rounds
  for each row execute function public.sync_dt_round_stats();

create or replace function public.bump_dt_round_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.dt_rounds
  set dragon_total = dragon_total + case when new.side = 'dragon' then new.amount else 0 end,
      tiger_total  = tiger_total + case when new.side = 'tiger' then new.amount else 0 end,
      player_count = player_count + 1,
      updated_at   = now()
  where id = new.round_id;
  return new;
end;
$$;

drop trigger if exists trg_dt_bids_bump_totals on public.dt_bids;
create trigger trg_dt_bids_bump_totals
  after insert on public.dt_bids
  for each row execute function public.bump_dt_round_totals();

-- ---------------------------------------------------------------------------
-- 4) Row Level Security
-- ---------------------------------------------------------------------------
alter table public.dt_rounds      enable row level security;
alter table public.dt_bids        enable row level security;
alter table public.dt_round_stats enable row level security;

-- dt_rounds: NO select policy (fee_amount hidden). Clients use public_dt_rounds.
-- dt_bids: users read ONLY their own bids (other players' sides stay hidden).
drop policy if exists "dt_bids_select_own" on public.dt_bids;
create policy "dt_bids_select_own"
  on public.dt_bids for select to authenticated
  using (auth.uid() = user_id);

-- dt_round_stats: public live data (totals per side, no money secrets).
drop policy if exists "dt_round_stats_select_all" on public.dt_round_stats;
create policy "dt_round_stats_select_all"
  on public.dt_round_stats for select to authenticated
  using (true);

grant select on public.public_dt_rounds to authenticated;
grant select on public.dt_round_stats   to authenticated;
grant select on public.dt_bids          to authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPCs
-- ---------------------------------------------------------------------------

-- Resolve due dragon-tiger rounds (called opportunistically).
create or replace function public.dt_resolve_due_rounds()
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
    select id from public.dt_rounds
    where status = 'open' and ends_at <= now()
    order by ends_at
    limit 20
  loop
    perform public.dt_resolve_round(v_id);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'resolved', v_count);
end;
$$;

-- Get (or create) the current open dragon-tiger round. Round numbers reset
-- to 1,2,3... at 12:00 AM PKT daily, like Squad Stakes / Coin Flip.
create or replace function public.dt_get_current_round()
returns public.public_dt_rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_round     public.public_dt_rounds%rowtype;
  v_today     date := (now() at time zone 'Asia/Karachi')::date;
  v_last_date date;
  v_next_no   integer;
begin
  perform public.dt_resolve_due_rounds();

  select id into v_id
  from public.dt_rounds
  where status = 'open'
  order by starts_at desc
  limit 1;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('winsquad_dt_current_round'));
    select id into v_id from public.dt_rounds where status = 'open' limit 1;
    if v_id is null then
      select (starts_at at time zone 'Asia/Karachi')::date into v_last_date
      from public.dt_rounds
      order by starts_at desc
      limit 1;

      if v_last_date is null or v_last_date < v_today then
        v_next_no := 1;
      else
        select coalesce(max(round_no), 0) + 1 into v_next_no
        from public.dt_rounds
        where (starts_at at time zone 'Asia/Karachi')::date = v_today;
      end if;

      insert into public.dt_rounds (round_no, starts_at, ends_at, status)
      values (v_next_no, now(), now() + interval '30 seconds', 'open')
      returning id into v_id;
    end if;
  end if;

  select * into v_round from public.public_dt_rounds where id = v_id;
  if v_round.id is null then
    raise exception 'dragon tiger round vanished unexpectedly';
  end if;
  return v_round;
end;
$$;

-- Place a bet on dragon/tiger in a round.
create or replace function public.dt_place_bid(
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
  v_round public.dt_rounds%rowtype;
  v_bid_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;

  v_side := lower(trim(coalesce(p_side, '')));
  if v_side not in ('dragon', 'tiger') then
    return jsonb_build_object('ok', false, 'error', 'choose dragon or tiger');
  end if;

  p_amount := round(p_amount, 2);
  if p_amount is null or p_amount < 10 then
    return jsonb_build_object('ok', false, 'error', 'minimum bet is Rs 10');
  end if;
  if p_amount > 100000 then
    return jsonb_build_object('ok', false, 'error', 'maximum bet is Rs 100,000');
  end if;

  perform public.dt_resolve_due_rounds();

  select * into v_round from public.dt_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' or v_round.ends_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'round is closed');
  end if;

  if exists (select 1 from public.dt_bids where round_id = p_round_id and user_id = v_uid) then
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
  values (v_uid, 'dragontiger_bet', p_amount, 'completed', 'wallet',
          'Dragon Tiger round #' || v_round.round_no || ' · bet ' || upper(v_side));

  insert into public.dt_bids (round_id, user_id, side, amount)
  values (p_round_id, v_uid, v_side, p_amount)
  returning id into v_bid_id;
  -- dt_rounds totals are bumped by trg_dt_bids_bump_totals.

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

-- Deal two distinct cards; the winning side gets the higher card (visual
-- reveal matches the WinSquad-formula outcome).
create or replace function public.dt_deal_cards(p_winning_side text,
  out o_dragon_card text, out o_tiger_card text)
language plpgsql
as $$
declare
  v_dr integer; v_tr integer;
  v_ds text;    v_ts text;
  v_suits text[] := array['♠','♥','♦','♣'];
begin
  v_dr := 1 + floor(random() * 13)::int;
  loop
    v_tr := 1 + floor(random() * 13)::int;
    exit when v_tr <> v_dr;
  end loop;
  -- Winner must hold the higher card.
  if p_winning_side = 'dragon' and v_dr < v_tr then
    v_dr := v_dr + v_tr; v_tr := v_dr - v_tr; v_dr := v_dr - v_tr; -- swap
  elsif p_winning_side = 'tiger' and v_tr < v_dr then
    v_dr := v_dr + v_tr; v_tr := v_dr - v_tr; v_dr := v_dr - v_tr; -- swap
  end if;
  v_ds := v_suits[1 + floor(random() * 4)::int];
  v_ts := v_suits[1 + floor(random() * 4)::int];
  o_dragon_card :=
    case v_dr when 1 then 'A' when 11 then 'J' when 12 then 'Q' when 13 then 'K'
              else v_dr::text end || v_ds;
  o_tiger_card :=
    case v_tr when 1 then 'A' when 11 then 'J' when 12 then 'Q' when 13 then 'K'
              else v_tr::text end || v_ts;
end;
$$;

-- Settle a dragon-tiger round. IDEMPOTENT: no-op if already closed.
--   * side with the LOWER total wins; winners get 2x their bet from the
--     losers' pool; the remainder is the (hidden) company fee.
--   * if losers' pool < 2x winners' total -> winners split the losers'
--     pool proportionally (fee = 0).
--   * SAME-SIDE RULE: all bids on one side -> they ALL LOSE, no refund.
--   * exact tie on totals -> round cancelled, all bids refunded.
create or replace function public.dt_resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round   public.dt_rounds%rowtype;
  v_d       numeric(12,2);
  v_t       numeric(12,2);
  v_wside   text;
  v_wtotal  numeric(12,2);
  v_ltotal  numeric(12,2);
  v_fee     numeric(12,2) := 0;
  v_paid    numeric(12,2) := 0;
  v_payout  numeric(12,2);
  v_dcard   text;
  v_tcard   text;
  r         record;
begin
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;

  select * into v_round from public.dt_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' then
    return jsonb_build_object('ok', true, 'already_closed', true,
                              'winning_side', v_round.winning_side,
                              'dragon_card', v_round.dragon_card,
                              'tiger_card', v_round.tiger_card);
  end if;

  -- Security guard: cannot settle before round ends
  if v_round.ends_at > now() then
    return jsonb_build_object('ok', false, 'error', 'round not ended yet');
  end if;

  update public.dt_rounds set status = 'resolving', updated_at = now()
  where id = p_round_id;

  select coalesce(sum(amount) filter (where side = 'dragon'), 0),
         coalesce(sum(amount) filter (where side = 'tiger'), 0)
  into v_d, v_t
  from public.dt_bids
  where round_id = p_round_id;

  -- SAME-SIDE RULE: all players on one side -> they ALL LOSE (money to company).
  -- No refund. The empty side "wins" by default.
  if v_d = 0 or v_t = 0 then
    update public.dt_bids
    set is_winner = false, payout = 0
    where round_id = p_round_id;

    v_fee := v_d + v_t; -- company keeps all
    v_wside := case when v_d = 0 then 'tiger' else 'dragon' end;
    select o_dragon_card, o_tiger_card into v_dcard, v_tcard
    from public.dt_deal_cards(v_wside);

    update public.dt_rounds
    set status = 'closed', winning_side = v_wside,
        dragon_card = v_dcard, tiger_card = v_tcard,
        fee_amount = v_fee,
        dragon_total = v_d, tiger_total = v_t, updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'same_side_loss', true,
                              'winning_side', v_wside,
                              'dragon_card', v_dcard, 'tiger_card', v_tcard,
                              'dragon_total', v_d, 'tiger_total', v_t,
                              'fee', v_fee);
  end if;

  -- Exact tie on totals -> refund everybody.
  if v_d = v_t then
    for r in select user_id, amount from public.dt_bids
             where round_id = p_round_id and not refunded
    loop
      update public.wallets
      set balance = balance + r.amount, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'payout', r.amount, 'completed', 'wallet',
              'Dragon Tiger round #' || v_round.round_no || ' cancelled — bid refunded');
      update public.dt_bids
      set refunded = true, is_winner = false, payout = 0
      where round_id = p_round_id and user_id = r.user_id;
    end loop;

    update public.dt_rounds
    set status = 'closed', winning_side = null,
        dragon_card = null, tiger_card = null, fee_amount = 0,
        dragon_total = v_d, tiger_total = v_t, updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'cancelled', true,
                              'dragon_total', v_d, 'tiger_total', v_t);
  end if;

  -- Lower-total side wins.
  if v_d < v_t then
    v_wside := 'dragon'; v_wtotal := v_d; v_ltotal := v_t;
  else
    v_wside := 'tiger'; v_wtotal := v_t; v_ltotal := v_d;
  end if;

  -- Deal cards: winner holds the higher card.
  select o_dragon_card, o_tiger_card into v_dcard, v_tcard
  from public.dt_deal_cards(v_wside);

  if v_ltotal >= 2 * v_wtotal then
    -- Full 2x payouts; company keeps the remainder.
    for r in select user_id, amount from public.dt_bids
             where round_id = p_round_id and side = v_wside
             order by placed_at
    loop
      v_payout := round(r.amount * 2, 2);
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'dragontiger_win', v_payout, 'completed', 'wallet',
              'Dragon Tiger round #' || v_round.round_no || ' · ' ||
              upper(v_wside) || ' wins · 2x payout');
      update public.dt_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
    end loop;
    v_fee := v_ltotal - v_paid;
  else
    -- Pool too small for full 2x: winners split losers' pool proportionally.
    -- Truncate to paisa so the sum can never exceed the pool.
    for r in select user_id, amount from public.dt_bids
             where round_id = p_round_id and side = v_wside
             order by placed_at
    loop
      v_payout := floor(r.amount / v_wtotal * v_ltotal * 100) / 100;
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'dragontiger_win', v_payout, 'completed', 'wallet',
              'Dragon Tiger round #' || v_round.round_no || ' · ' ||
              upper(v_wside) || ' wins · proportional payout');
      update public.dt_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
    end loop;
    v_fee := v_ltotal - v_paid;  -- >= 0 by truncation
  end if;

  -- Mark losers.
  update public.dt_bids
  set is_winner = false, payout = 0
  where round_id = p_round_id and side <> v_wside;

  update public.dt_rounds
  set status = 'closed', winning_side = v_wside,
      dragon_card = v_dcard, tiger_card = v_tcard, fee_amount = v_fee,
      dragon_total = v_d, tiger_total = v_t, updated_at = now()
  where id = p_round_id;

  return jsonb_build_object('ok', true, 'cancelled', false,
                            'winning_side', v_wside,
                            'dragon_card', v_dcard, 'tiger_card', v_tcard,
                            'dragon_total', v_d, 'tiger_total', v_t,
                            'winners_paid', v_paid);
end;
$$;

-- Re-apply the transactions select/insert grants (harmless if re-run).
grant select, insert on public.transactions to authenticated;
