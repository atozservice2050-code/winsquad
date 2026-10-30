-- ============================================================================
-- 027 — Private tables playable with 3 players (was: hard-locked to 4).
--
-- Bug: a table only became 'active' when the 4TH seat filled, and
-- place_private_bid rejects non-active tables with "table is not active".
-- So 3 friends seated together could not bid at all (reported live on
-- table 9X8-3HR, 2026-10-30). WinSquad's standing rule everywhere else is
-- that play starts at 3 real players; private tables now match:
--   * table turns 'active' when the 3rd seat fills (4th can still join);
--   * a round resolves when ALL SEATED players have bid (3 or 4 bids);
--   * highest bidder still loses alone; winners split 90% proportionally.
-- Existing waiting tables that already have 3+ seats are activated below.
-- ============================================================================

-- 1) Join: activate at 3 seats instead of 4.
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

-- 2) Resolve: complete when every seated player has bid (min 3 bids).
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

  if v_n < 3 or v_n < v_seats then
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

-- 3) Activate existing waiting tables that already have 3+ seated players.
update public.private_tables t
set status = 'active'
where t.status = 'waiting'
  and (select count(*) from public.private_seats s where s.table_id = t.id) >= 3;
