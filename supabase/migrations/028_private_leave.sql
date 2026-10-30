-- ============================================================================
-- 028 — Private tables: real LEAVE + live-round rules.
--
-- Problem (reported live 2026-10-30): "Leave table" only changed the
-- leaver's own screen — the seat row stayed in private_seats forever, so
-- the player kept showing as seated on everyone else's screen.
--
-- Fix:
--  1) leave_private_table(): actually deletes the caller's seat. If the
--     table drops below 2 seated it goes back to 'waiting' (a round that
--     already started may still be finished — see 2/3). If the LAST
--     player leaves, the current round can never complete: its bids go
--     to the HOUSE FEE — NO refund (owner rule, 2026-10-30) — and the
--     table is closed. Leaving also re-checks
--     resolution: if the leaver was the only player who had not bid,
--     the round completes for the rest.
--  2) resolve_private_round(): a round is complete when every CURRENTLY
--     SEATED player has bid and at least 2 bids are in — a bid placed by
--     a player who then left still counts (their money is in the pot;
--     payouts go to wallets whether or not they are still seated).
--  3) place_private_bid(): the gate checks the SEAT COUNT directly
--     (a table needs 2+ seated players to accept bids) and self-heals
--     the status flag to 'active' — the same design as migration
--     027_private_table_min3.sql, restated here so the live database
--     converges on one rule set together with the leave-aware resolve.
-- ============================================================================

-- 1) Leave RPC ---------------------------------------------------------------
create or replace function public.leave_private_table(p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_tbl   public.private_tables%rowtype;
  v_left  int;
  v_pot   numeric(12,2) := 0;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;

  select * into v_tbl from public.private_tables where id = p_table_id for update;
  if v_tbl.id is null then
    return jsonb_build_object('ok', false, 'error', 'table not found');
  end if;

  delete from public.private_seats
  where table_id = p_table_id and user_id = v_uid;
  if not found then
    return jsonb_build_object('ok', true, 'already_left', true);
  end if;

  select count(*) into v_left from public.private_seats where table_id = p_table_id;

  if v_left = 0 then
    -- Last player out: the round can never complete, so the bids placed
    -- in the current round go to the house fee (owner rule: NO refund)
    -- and the table closes.
    select coalesce(sum(amount), 0) into v_pot
    from public.private_bids
    where table_id = p_table_id and round_no = v_tbl.current_round_no;
    delete from public.private_bids
    where table_id = p_table_id and round_no = v_tbl.current_round_no;
    update public.private_tables
    set status = 'closed', fee_amount = fee_amount + v_pot
    where id = p_table_id;
    return jsonb_build_object('ok', true, 'seats_left', 0, 'status', 'closed',
                              'fee_taken', v_pot);
  end if;

  if v_left < 2 and v_tbl.status = 'active' then
    update public.private_tables set status = 'waiting' where id = p_table_id;
    v_tbl.status := 'waiting';
  end if;

  -- If the leaver was the only player who had not bid, the round can
  -- complete for the remaining players right now.
  perform public.resolve_private_round(p_table_id);

  return jsonb_build_object('ok', true, 'seats_left', v_left, 'status', v_tbl.status);
end;
$$;

grant execute on function public.leave_private_table(uuid) to authenticated;

-- 2) Resolve: complete when all SEATED players have bid and >= 2 bids ----
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
  v_pending  int;
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

  -- Seated players who have not bid yet are still pending. A bid from a
  -- player who has since left still counts toward the round.
  select count(*) into v_pending
  from public.private_seats s
  where s.table_id = p_table_id
    and not exists (
      select 1 from public.private_bids b
      where b.table_id = p_table_id and b.round_no = v_rno and b.user_id = s.user_id
    );

  if v_n < 2 or v_pending > 0 then
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

-- 3) Bid gate: seat-count check (>= 2) + status self-heal ---------------
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

  if v_seats < 2 then
    return jsonb_build_object('ok', false, 'error', 'Need 2 players seated to start the table');
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
