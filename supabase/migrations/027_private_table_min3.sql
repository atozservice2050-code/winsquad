-- ============================================================================
-- 027 — Private tables: a table starts at 3 players, not 4.
--
-- Bug (reported 2026-10-30): with 3 players seated, placing a bid failed
-- with "table is not active". Root cause: join_private_table only set
-- status='active' when the 4TH seat filled, place_private_bid rejected
-- any non-'active' table, and resolve_private_round waited for exactly
-- 4 bids — so a 3-player table (the app-wide minimum for real play)
-- could never start.
--
-- Fix:
--  * join_private_table: table becomes 'active' when the 3rd seat fills
--    (a 4th player can still join an active table).
--  * place_private_bid: allowed when >= 3 players are seated; a
--    'waiting' table with >= 3 seats auto-activates; a 'closed' table
--    and a table with < 3 seats are rejected.
--  * resolve_private_round: resolves when every SEATED player has bid
--    (3 or 4 bids); single highest bidder still loses, the rest split
--    90% of the loser's amount proportionally, 10% fee unchanged.
--  * Backfill: existing 'waiting' tables that already have >= 3 seats
--    (e.g. 9X8-3HR) become 'active' immediately.
-- ============================================================================

create or replace function public.join_private_table(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_norm text;
  v_tbl  public.private_tables%rowtype;
  v_seat smallint;
  v_n    int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_code is null or trim(p_code) = '' then
    return jsonb_build_object('ok', false, 'error', 'invite code required');
  end if;

  v_norm := upper(regexp_replace(p_code, '[^A-Z0-9]', '', 'gi'));

  select t.* into v_tbl
  from public.private_tables t
  where replace(t.code, '-', '') = v_norm
    and t.status in ('waiting', 'active')
  limit 1;

  if v_tbl.id is null then
    return jsonb_build_object('ok', false, 'error', 'table not found or closed');
  end if;

  -- idempotent re-join
  select seat_no into v_seat
  from public.private_seats
  where table_id = v_tbl.id and user_id = v_uid;
  if found then
    return jsonb_build_object('ok', true, 'table_id', v_tbl.id,
                              'seat_no', v_seat, 'already_seated', true,
                              'status', v_tbl.status);
  end if;

  -- serialize seat fills
  select * into v_tbl from public.private_tables where id = v_tbl.id for update;

  select count(*) into v_n from public.private_seats where table_id = v_tbl.id;
  if v_n >= 4 then
    return jsonb_build_object('ok', false, 'error', 'table is full');
  end if;

  select s into v_seat
  from generate_series(1, 4) s
  where not exists (
    select 1 from public.private_seats ps
    where ps.table_id = v_tbl.id and ps.seat_no = s
  )
  order by s
  limit 1;

  insert into public.private_seats (table_id, user_id, seat_no)
  values (v_tbl.id, v_uid, v_seat);

  if v_n + 1 >= 3 then
    update public.private_tables set status = 'active' where id = v_tbl.id;
    v_tbl.status := 'active';
  end if;

  return jsonb_build_object('ok', true, 'table_id', v_tbl.id,
                            'seat_no', v_seat, 'status', v_tbl.status);
end;
$$;

create or replace function public.resolve_private_round(p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tbl      public.private_tables%rowtype;
  v_rno      int;
  v_n        int;
  v_seats    int;
  v_loser_id uuid;
  v_loser_amt numeric(12,2);
  v_bid      record;
  v_wtot     numeric(12,2);
  v_fee      numeric(12,2);
  v_dist     numeric(12,2);
  v_payout   numeric(12,2);
  v_paid     numeric(12,2) := 0;
  v_winners  int := 0;
begin
  if p_table_id is null then
    return jsonb_build_object('ok', false, 'error', 'table id required');
  end if;

  perform pg_advisory_xact_lock(hashtext('winsquad_priv_' || p_table_id::text));

  select * into v_tbl from public.private_tables where id = p_table_id for update;
  if v_tbl.id is null then
    return jsonb_build_object('ok', false, 'error', 'table not found');
  end if;
  v_rno := v_tbl.current_round_no;

  select count(*) into v_n
  from public.private_bids
  where table_id = p_table_id and round_no = v_rno;

  select count(*) into v_seats
  from public.private_seats
  where table_id = p_table_id;

  if v_seats < 3 or v_n < v_seats then
    return jsonb_build_object('ok', true, 'waiting', true,
                              'bids', v_n, 'round_no', v_rno);
  end if;

  -- single highest loses; tie-break: earliest placed_at loses
  select user_id, amount into v_loser_id, v_loser_amt
  from public.private_bids
  where table_id = p_table_id and round_no = v_rno
  order by amount desc, placed_at asc
  limit 1;

  v_fee  := floor(v_loser_amt * 0.10 * 100) / 100;
  v_dist := v_loser_amt - v_fee;

  select sum(amount) into v_wtot
  from public.private_bids
  where table_id = p_table_id and round_no = v_rno and user_id <> v_loser_id;

  for v_bid in
    select user_id, amount
    from public.private_bids
    where table_id = p_table_id and round_no = v_rno and user_id <> v_loser_id
    order by placed_at asc
  loop
    v_payout := floor((v_dist * v_bid.amount / v_wtot) * 100) / 100;
    v_paid   := v_paid + v_payout;
    v_winners := v_winners + 1;

    update public.wallets
    set balance = balance + v_payout, updated_at = now()
    where user_id = v_bid.user_id;

    insert into public.transactions (user_id, type, amount, status, note)
    values (v_bid.user_id, 'payout', v_payout, 'completed',
            'Private table winnings (round ' || v_rno || ')');
  end loop;

  update public.private_tables
  set current_round_no = current_round_no + 1,
      fee_amount = fee_amount + v_fee + (v_dist - v_paid)  -- dust -> house, HIDDEN
  where id = p_table_id;

  return jsonb_build_object(
    'ok', true,
    'resolved', true,
    'round_no', v_rno,
    'winners', v_winners,
    'losers_pool', v_loser_amt,
    'total_payout', v_paid
  );
end;
$$;

create or replace function public.place_private_bid(
  p_table_id uuid,
  p_amount   numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_tbl    public.private_tables%rowtype;
  v_bid_id uuid;
  v_res    jsonb;
  v_seats  int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;

  p_amount := round(p_amount, 2);
  if p_amount is null or p_amount < 500 or p_amount > 1000000 then
    return jsonb_build_object('ok', false, 'error', 'minimum bid is Rs 500');
  end if;

  select * into v_tbl from public.private_tables where id = p_table_id for update;
  if v_tbl.id is null then
    return jsonb_build_object('ok', false, 'error', 'table not found');
  end if;
  if v_tbl.status = 'closed' then
    return jsonb_build_object('ok', false, 'error', 'table is closed');
  end if;

  select count(*) into v_seats
  from public.private_seats
  where table_id = p_table_id;

  if v_seats < 3 then
    return jsonb_build_object('ok', false, 'error', 'Need 3 players seated to start the table');
  end if;

  if v_tbl.status <> 'active' then
    update public.private_tables set status = 'active' where id = p_table_id;
    v_tbl.status := 'active';
  end if;

  if not exists (
    select 1 from public.private_seats
    where table_id = p_table_id and user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'error', 'you are not seated at this table');
  end if;

  if exists (
    select 1 from public.private_bids
    where table_id = p_table_id and round_no = v_tbl.current_round_no and user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'error', 'already placed a bid this round');
  end if;

  update public.wallets
  set balance = balance - p_amount, updated_at = now()
  where user_id = v_uid and balance >= p_amount;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'insufficient balance');
  end if;

  insert into public.transactions (user_id, type, amount, status, note)
  values (v_uid, 'stake', p_amount, 'completed',
          'Private table bid (round ' || v_tbl.current_round_no || ')');

  insert into public.private_bids (table_id, round_no, user_id, amount)
  values (p_table_id, v_tbl.current_round_no, v_uid, p_amount)
  returning id into v_bid_id;

  v_res := public.resolve_private_round(p_table_id);

  return jsonb_build_object(
    'ok', true,
    'bid_id', v_bid_id,
    'amount', p_amount,
    'round_no', v_tbl.current_round_no,
    'resolved', coalesce((v_res ->> 'resolved')::boolean, false)
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already placed a bid this round');
end;
$$;


-- Backfill: activate tables that already have 3+ players seated.
update public.private_tables t
set status = 'active'
where t.status = 'waiting'
  and (select count(*) from public.private_seats s where s.table_id = t.id) >= 3;
