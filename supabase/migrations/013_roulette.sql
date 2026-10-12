-- Migration 013: Roulette (American, multiplayer, 30-second rounds)
--
-- Game rules (user-specified):
--   * American Roulette: numbers 0, 00, 1-36.
--   * Rounds run 30 seconds, like Squad Stakes / Coin Flip / Dragon Tiger.
--   * Players place chips on: single numbers (35:1), Red/Black (1:1),
--     Odd/Even (1:1), 1-18 / 19-36 (1:1), Dozens 1st/2nd/3rd 12 (2:1).
--   * Multiple bets per user per round allowed (different spots).
--   * HOUSE CONTROL: the winning number is chosen SERVER-SIDE by
--     roulette_pick_number(), which minimizes the company's payout
--     liability (picks randomly among the cheapest numbers so the
--     outcome is not trivially predictable). The ball animation lands
--     on whatever number the backend decided.
--   * Winners are paid amount * (odds+1) from the total bet pool.
--     fee_amount = total_bet - paid_out goes to the company (HIDDEN).
--   * No real bets -> round closes with a drawn number, no payouts.
--
-- Tables: roulette_rounds, roulette_bids, roulette_round_stats
--         (+ public_roulette_rounds view).
-- RPCs: roulette_get_current_round(), roulette_place_bets(),
--       roulette_resolve_round(), roulette_resolve_due_rounds(),
--       roulette_pick_number() (house-controlled draw).
-- Ledger: 'roulette_bet' (stake), 'roulette_win' (payout).
-- Run in Supabase SQL Editor (project: winsquad).

-- ---------------------------------------------------------------------------
-- 1) Widen the transactions type check to include roulette types.
--    (Preserves every type added by earlier migrations.)
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
                 'dragontiger_bet','dragontiger_win',
                 'andarbahar_bet','andarbahar_win',
                 'roulette_bet','roulette_win'));

-- ---------------------------------------------------------------------------
-- 2) Tables
-- ---------------------------------------------------------------------------
create table if not exists public.roulette_rounds (
  id             uuid primary key default gen_random_uuid(),
  round_no       integer not null,
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz not null,
  status         text not null default 'open'
                   check (status in ('open','resolving','closed')),
  winning_number text check (winning_number in
                   ('0','00','1','2','3','4','5','6','7','8','9','10','11','12',
                    '13','14','15','16','17','18','19','20','21','22','23','24',
                    '25','26','27','28','29','30','31','32','33','34','35','36')),
  total_bet      numeric(12,2) not null default 0,
  player_count   integer not null default 0,
  fee_amount     numeric(12,2) not null default 0, -- company cut, HIDDEN
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.roulette_bids (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references public.roulette_rounds(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  bet_type   text not null check (bet_type in
               ('straight','red','black','odd','even','low','high',
                'dozen1','dozen2','dozen3')),
  bet_value  text not null default '',  -- straight: '0','00','1'..'36'; else ''
  amount     numeric(12,2) not null check (amount >= 10),
  is_winner  boolean,                    -- set at resolve; null = unresolved
  payout     numeric(12,2),              -- winner payout (0 for losers)
  refunded   boolean not null default false,
  placed_at  timestamptz not null default now(),
  unique (round_id, user_id, bet_type, bet_value)  -- re-bet same spot stacks
);

-- Realtime-safe mirror of roulette_rounds (no fee column). Maintained by triggers.
create table if not exists public.roulette_round_stats (
  round_id       uuid primary key references public.roulette_rounds(id) on delete cascade,
  round_no       integer not null,
  total_bet      numeric(12,2) not null default 0,
  player_count   integer not null default 0,
  ends_at        timestamptz not null,
  status         text not null,
  winning_number text,
  updated_at     timestamptz not null default now()
);

create index if not exists idx_roulette_bids_round on public.roulette_bids (round_id);
create index if not exists idx_roulette_rounds_status on public.roulette_rounds (status, ends_at);

-- Public view (fee_amount excluded — never reaches clients).
create or replace view public.public_roulette_rounds as
select id, round_no, starts_at, ends_at, status,
       winning_number, total_bet, player_count, created_at
from public.roulette_rounds;

-- ---------------------------------------------------------------------------
-- 3) Trigger: roulette_rounds -> roulette_round_stats
-- ---------------------------------------------------------------------------
create or replace function public.sync_roulette_round_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.roulette_round_stats
    (round_id, round_no, total_bet, player_count, ends_at, status, winning_number)
  values
    (new.id, new.round_no, new.total_bet, new.player_count,
     new.ends_at, new.status, new.winning_number)
  on conflict (round_id) do update set
    round_no       = excluded.round_no,
    total_bet      = excluded.total_bet,
    player_count   = excluded.player_count,
    ends_at        = excluded.ends_at,
    status         = excluded.status,
    winning_number = excluded.winning_number,
    updated_at     = now();
  return new;
end;
$$;

drop trigger if exists trg_roulette_rounds_sync_stats on public.roulette_rounds;
create trigger trg_roulette_rounds_sync_stats
  after insert or update on public.roulette_rounds
  for each row execute function public.sync_roulette_round_stats();

-- ---------------------------------------------------------------------------
-- 4) Row Level Security
-- ---------------------------------------------------------------------------
alter table public.roulette_rounds      enable row level security;
alter table public.roulette_bids        enable row level security;
alter table public.roulette_round_stats enable row level security;

-- roulette_rounds: NO select policy (fee_amount hidden). Clients use the view.
-- roulette_bids: users read ONLY their own bids.
drop policy if exists "roulette_bids_select_own" on public.roulette_bids;
create policy "roulette_bids_select_own"
  on public.roulette_bids for select to authenticated
  using (auth.uid() = user_id);

-- roulette_round_stats: public live data.
drop policy if exists "roulette_round_stats_select_all" on public.roulette_round_stats;
create policy "roulette_round_stats_select_all"
  on public.roulette_round_stats for select to authenticated
  using (true);

grant select on public.public_roulette_rounds to authenticated;
grant select on public.roulette_round_stats   to authenticated;
grant select on public.roulette_bids          to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Helpers + RPCs
-- ---------------------------------------------------------------------------

-- Payout multiplier for a bet given the winning number (0 = loses).
-- straight 35:1 -> 36x, dozens 2:1 -> 3x, even-money 1:1 -> 2x.
create or replace function public.roulette_bet_multiplier(
  p_bet_type text, p_bet_value text, p_win text)
returns integer
language plpgsql
immutable
as $$
declare
  v_red int[] := array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
  v_n   int;
begin
  if p_win is null then return 0; end if;
  -- '00'::int = 0 in Postgres, safe for range checks below.
  v_n := p_win::int;

  case p_bet_type
    when 'straight' then
      if p_bet_value = p_win then return 36; end if;
    when 'red' then
      if p_win not in ('0','00') and v_n = any(v_red) then return 2; end if;
    when 'black' then
      if p_win not in ('0','00') and not (v_n = any(v_red)) then return 2; end if;
    when 'odd' then
      if p_win not in ('0','00') and v_n % 2 = 1 then return 2; end if;
    when 'even' then
      if p_win not in ('0','00') and v_n % 2 = 0 then return 2; end if;
    when 'low' then
      if v_n between 1 and 18 then return 2; end if;
    when 'high' then
      if v_n between 19 and 36 then return 2; end if;
    when 'dozen1' then
      if v_n between 1 and 12 then return 3; end if;
    when 'dozen2' then
      if v_n between 13 and 24 then return 3; end if;
    when 'dozen3' then
      if v_n between 25 and 36 then return 3; end if;
    else
      return 0;
  end case;
  return 0;
end;
$$;

-- HOUSE-CONTROLLED draw: pick the winning number server-side.
-- Chooses randomly among the 6 numbers with the lowest total payout
-- liability, so the house keeps the maximum while the outcome is not
-- trivially predictable. No bids -> uniform random draw.
create or replace function public.roulette_pick_number(p_round_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidates text[] := array[
    '0','00','1','2','3','4','5','6','7','8','9','10','11','12','13','14',
    '15','16','17','18','19','20','21','22','23','24','25','26','27','28',
    '29','30','31','32','33','34','35','36'];
  v_best text;
begin
  if p_round_id is null then
    return v_candidates[1 + floor(random() * 38)::int];
  end if;

  with liab as (
    select c.n as num,
           coalesce(sum(b.amount *
             public.roulette_bet_multiplier(b.bet_type, b.bet_value, c.n)), 0)
             as liability
    from unnest(v_candidates) as c(n)
    left join public.roulette_bids b on b.round_id = p_round_id
    group by c.n
  )
  select num into v_best
  from (select num from liab order by liability asc limit 6) s
  order by random()
  limit 1;

  if v_best is null then
    v_best := v_candidates[1 + floor(random() * 38)::int];
  end if;
  return v_best;
end;
$$;

-- Resolve due roulette rounds (called opportunistically).
create or replace function public.roulette_resolve_due_rounds()
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
    select id from public.roulette_rounds
    where status = 'open' and ends_at <= now()
    order by ends_at
    limit 20
  loop
    perform public.roulette_resolve_round(v_id);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'resolved', v_count);
end;
$$;

-- Get (or create) the current open roulette round. Round numbers reset
-- to 1,2,3... at 12:00 AM PKT daily, like the other games.
create or replace function public.roulette_get_current_round()
returns public.public_roulette_rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_round     public.public_roulette_rounds%rowtype;
  v_today     date := (now() at time zone 'Asia/Karachi')::date;
  v_last_date date;
  v_next_no   integer;
begin
  perform public.roulette_resolve_due_rounds();

  select id into v_id
  from public.roulette_rounds
  where status = 'open'
  order by starts_at desc
  limit 1;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('winsquad_roulette_current_round'));
    select id into v_id from public.roulette_rounds where status = 'open' limit 1;
    if v_id is null then
      select (starts_at at time zone 'Asia/Karachi')::date into v_last_date
      from public.roulette_rounds
      order by starts_at desc
      limit 1;

      if v_last_date is null or v_last_date < v_today then
        v_next_no := 1;
      else
        select coalesce(max(round_no), 0) + 1 into v_next_no
        from public.roulette_rounds
        where (starts_at at time zone 'Asia/Karachi')::date = v_today;
      end if;

      insert into public.roulette_rounds (round_no, starts_at, ends_at, status)
      values (v_next_no, now(), now() + interval '30 seconds', 'open')
      returning id into v_id;
    end if;
  end if;

  select * into v_round from public.public_roulette_rounds where id = v_id;
  if v_round.id is null then
    raise exception 'roulette round vanished unexpectedly';
  end if;
  return v_round;
end;
$$;

-- Place a batch of roulette bets in one round (one atomic wallet debit).
-- p_bets: jsonb array of {"bet_type": "...", "bet_value": "...", "amount": N}.
-- Re-betting the same spot stacks onto the existing bid.
create or replace function public.roulette_place_bets(
  p_round_id uuid,
  p_bets     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_round  public.roulette_rounds%rowtype;
  v_total  numeric(12,2) := 0;
  v_count  integer := 0;
  v_valid_types text[] := array['straight','red','black','odd','even','low',
                               'high','dozen1','dozen2','dozen3'];
  v_numbers text[] := array[
    '0','00','1','2','3','4','5','6','7','8','9','10','11','12','13','14',
    '15','16','17','18','19','20','21','22','23','24','25','26','27','28',
    '29','30','31','32','33','34','35','36'];
  b        jsonb;
  v_btype  text;
  v_bval   text;
  v_amt    numeric(12,2);
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;
  if jsonb_typeof(p_bets) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bets must be a list');
  end if;

  v_count := jsonb_array_length(p_bets);
  if v_count < 1 or v_count > 25 then
    return jsonb_build_object('ok', false, 'error', 'place 1-25 bets at a time');
  end if;

  perform public.roulette_resolve_due_rounds();

  select * into v_round from public.roulette_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' or v_round.ends_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'round is closed');
  end if;

  -- Validate every bet first, then debit once.
  for b in select * from jsonb_array_elements(p_bets)
  loop
    v_btype := lower(trim(coalesce(b->>'bet_type', '')));
    v_bval  := trim(coalesce(b->>'bet_value', ''));
    begin
      v_amt := round((b->>'amount')::numeric, 2);
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'bad bet amount');
    end;

    if not (v_btype = any(v_valid_types)) then
      return jsonb_build_object('ok', false, 'error', 'bad bet type');
    end if;
    if v_btype = 'straight' then
      if not (v_bval = any(v_numbers)) then
        return jsonb_build_object('ok', false, 'error', 'bad number');
      end if;
    else
      v_bval := '';
    end if;
    if v_amt is null or v_amt < 10 then
      return jsonb_build_object('ok', false, 'error', 'minimum bet is Rs 10');
    end if;
    if v_amt > 100000 then
      return jsonb_build_object('ok', false, 'error', 'maximum bet is Rs 100,000');
    end if;
    v_total := v_total + v_amt;
  end loop;

  -- Atomic debit; fails cleanly on insufficient balance.
  update public.wallets
  set balance = balance - v_total, updated_at = now()
  where user_id = v_uid and balance >= v_total;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'insufficient balance');
  end if;

  -- Insert / stack each bet.
  for b in select * from jsonb_array_elements(p_bets)
  loop
    v_btype := lower(trim(coalesce(b->>'bet_type', '')));
    v_bval  := case when v_btype = 'straight'
                    then trim(coalesce(b->>'bet_value', '')) else '' end;
    v_amt   := round((b->>'amount')::numeric, 2);

    insert into public.roulette_bids (round_id, user_id, bet_type, bet_value, amount)
    values (p_round_id, v_uid, v_btype, v_bval, v_amt)
    on conflict (round_id, user_id, bet_type, bet_value)
    do update set amount = public.roulette_bids.amount + excluded.amount;

    insert into public.transactions (user_id, type, amount, status, method, note)
    values (v_uid, 'roulette_bet', v_amt, 'completed', 'wallet',
            'Roulette round #' || v_round.round_no || ' · ' ||
            case when v_btype = 'straight' then 'number ' || v_bval
                 else v_btype end);
  end loop;

  -- Recompute round totals (covers stacked re-bets too).
  update public.roulette_rounds
  set total_bet    = (select coalesce(sum(amount), 0)
                      from public.roulette_bids where round_id = p_round_id),
      player_count = (select count(distinct user_id)
                      from public.roulette_bids where round_id = p_round_id),
      updated_at   = now()
  where id = p_round_id;

  return jsonb_build_object(
    'ok', true,
    'bets', v_count,
    'total', v_total,
    'round_no', v_round.round_no
  );
end;
$$;

-- Settle a roulette round. IDEMPOTENT: no-op if already closed.
--   * winning_number is drawn by roulette_pick_number() (house-controlled).
--   * winners paid amount * multiplier; losers lose their stake.
--   * fee_amount = total_bet - paid_out (hidden company cut, >= 0).
--   * no real bets -> round simply closes with the drawn number.
create or replace function public.roulette_resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round     public.roulette_rounds%rowtype;
  v_win       text;
  v_total_bet numeric(12,2);
  v_paid      numeric(12,2) := 0;
  v_fee       numeric(12,2) := 0;
  v_mult      integer;
  v_payout    numeric(12,2);
  r           record;
begin
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;

  select * into v_round from public.roulette_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' then
    return jsonb_build_object('ok', true, 'already_closed', true,
                              'winning_number', v_round.winning_number);
  end if;

  -- Security guard: cannot settle before round ends.
  if v_round.ends_at > now() then
    return jsonb_build_object('ok', false, 'error', 'round not ended yet');
  end if;

  update public.roulette_rounds set status = 'resolving', updated_at = now()
  where id = p_round_id;

  -- House-controlled draw.
  v_win := public.roulette_pick_number(p_round_id);

  select coalesce(sum(amount), 0) into v_total_bet
  from public.roulette_bids where round_id = p_round_id;

  if v_total_bet > 0 then
    for r in select user_id, bet_type, bet_value, amount
             from public.roulette_bids
             where round_id = p_round_id
             order by placed_at
    loop
      v_mult := public.roulette_bet_multiplier(r.bet_type, r.bet_value, v_win);
      if v_mult > 0 then
        v_payout := round(r.amount * v_mult, 2);
        v_paid := v_paid + v_payout;
        update public.wallets
        set balance = balance + v_payout, updated_at = now()
        where user_id = r.user_id;
        insert into public.transactions (user_id, type, amount, status, method, note)
        values (r.user_id, 'roulette_win', v_payout, 'completed', 'wallet',
                'Roulette round #' || v_round.round_no || ' · number ' || v_win ||
                ' · ' || r.bet_type ||
                case when r.bet_type = 'straight' then ' ' || r.bet_value else '' end ||
                ' wins');
        update public.roulette_bids
        set is_winner = true, payout = v_payout
        where round_id = p_round_id and user_id = r.user_id
          and bet_type = r.bet_type and bet_value = r.bet_value;
      else
        update public.roulette_bids
        set is_winner = false, payout = 0
        where round_id = p_round_id and user_id = r.user_id
          and bet_type = r.bet_type and bet_value = r.bet_value;
      end if;
    end loop;

    -- Safety net (unreachable with the house pick, which guarantees the
    -- minimum liability is below total_bet): scale down proportionally.
    if v_paid > v_total_bet then
      for r in select user_id, bet_type, bet_value, payout
               from public.roulette_bids
               where round_id = p_round_id and is_winner
      loop
        v_payout := floor(r.payout / v_paid * v_total_bet * 100) / 100;
        update public.wallets
        set balance = balance - (r.payout - v_payout), updated_at = now()
        where user_id = r.user_id;
        update public.roulette_bids
        set payout = v_payout
        where round_id = p_round_id and user_id = r.user_id
          and bet_type = r.bet_type and bet_value = r.bet_value;
      end loop;
      v_paid := v_total_bet;
    end if;
    v_fee := v_total_bet - v_paid;
  end if;

  update public.roulette_rounds
  set status = 'closed', winning_number = v_win,
      total_bet = v_total_bet, fee_amount = v_fee, updated_at = now()
  where id = p_round_id;

  return jsonb_build_object('ok', true, 'cancelled', false,
                            'winning_number', v_win,
                            'total_bet', v_total_bet,
                            'winners_paid', v_paid);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Lock down settlement: only the server (service_role) may settle rounds
--    directly. Clients settle implicitly via roulette_get_current_round(),
--    which runs as SECURITY DEFINER. (Same pattern as Andar Bahar 011.)
-- ---------------------------------------------------------------------------
revoke all on function public.roulette_resolve_round(uuid) from public, anon, authenticated;
revoke all on function public.roulette_resolve_due_rounds() from public, anon, authenticated;
revoke all on function public.roulette_pick_number(uuid) from public, anon, authenticated;
grant execute on function public.roulette_resolve_round(uuid) to service_role;
grant execute on function public.roulette_resolve_due_rounds() to service_role;
grant execute on function public.roulette_pick_number(uuid) to service_role;

-- Re-apply the transactions select/insert grants (harmless if re-run).
grant select, insert on public.transactions to authenticated;
