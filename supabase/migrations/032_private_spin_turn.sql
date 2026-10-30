-- ============================================================================
-- 032 — Private table MANUAL SPIN (owner order 2026-10-30):
--   Rounds no longer auto-resolve when the last bid lands. Once every
--   seated player has bid (>= 2 bids), the round waits: the spin turn
--   rotates by round — spinner = seated[(round_no - 1) % seated_count]
--   in seat order — and only that player may call spin_private_table,
--   which resolves the round (highest bidder loses, as before).
--   Bidding itself stays free (no turn order for bids).
--   place_private_bid therefore no longer resolves; leave_private_table
--   no longer resolves either, but if a leave strands a round that can
--   never complete (1 player left, only 1 bid), that bid is refunded
--   and cleared so the money is never stuck. The LAST player leaving
--   still sends the round's bids to the house fee (migration 028 rule).
--   'refund' is added to the transactions type list for that refund.
-- ============================================================================

-- The live type list is wider than schema.sql showed (all the game bet /
-- win / loss types) — the full live list is kept and 'refund' is added.
alter table public.transactions
  drop constraint transactions_type_check;
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
                  'dice_bet','dice_win','dice_loss',
                  'refund'));

-- ---------------------------------------------------------------------------
-- place_private_bid: same as migration 031, minus the auto-resolve.
-- ---------------------------------------------------------------------------
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
  v_seats  int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;

  p_amount := round(p_amount, 2);
  if p_amount is null or p_amount < 50 then
    return jsonb_build_object('ok', false, 'error', 'minimum bid is Rs 50');
  end if;
  if p_amount > 10000 then
    return jsonb_build_object('ok', false, 'error', 'maximum bid is Rs 10,000');
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

  -- NO auto-resolve: the round waits for the spin turn (spin_private_table).
  return jsonb_build_object(
    'ok', true,
    'bid_id', v_bid_id,
    'amount', p_amount,
    'round_no', v_tbl.current_round_no,
    'resolved', false
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already placed a bid this round');
end;
$$;

-- ---------------------------------------------------------------------------
-- spin_private_table: only the rotation spinner may call it, only when
-- every seated player has bid and there are >= 2 bids. Resolves the round.
-- ---------------------------------------------------------------------------
create or replace function public.spin_private_table(
  p_table_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_tbl       public.private_tables%rowtype;
  v_seated    uuid[];
  v_spinner   uuid;
  v_pending   int;
  v_bid_count int;
  v_res       jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;

  select * into v_tbl from public.private_tables where id = p_table_id for update;
  if v_tbl.id is null then
    return jsonb_build_object('ok', false, 'error', 'table not found');
  end if;
  if v_tbl.status = 'closed' then
    return jsonb_build_object('ok', false, 'error', 'table is closed');
  end if;

  if not exists (
    select 1 from public.private_seats
    where table_id = p_table_id and user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'error', 'you are not seated at this table');
  end if;

  select array_agg(user_id order by seat_no) into v_seated
  from public.private_seats
  where table_id = p_table_id;

  if coalesce(array_length(v_seated, 1), 0) < 2 then
    return jsonb_build_object('ok', false, 'error', 'Need 2 players seated to spin');
  end if;

  select count(*) into v_pending
  from public.private_seats s
  where s.table_id = p_table_id
    and not exists (
      select 1 from public.private_bids b
      where b.table_id = p_table_id
        and b.round_no = v_tbl.current_round_no
        and b.user_id = s.user_id
    );

  select count(*) into v_bid_count
  from public.private_bids
  where table_id = p_table_id and round_no = v_tbl.current_round_no;

  if v_pending > 0 or v_bid_count < 2 then
    return jsonb_build_object('ok', false, 'error', 'Round is not ready — waiting for all players to bid');
  end if;

  -- spin turn rotates by round over the seated players in seat order
  v_spinner := v_seated[((v_tbl.current_round_no - 1) % array_length(v_seated, 1)) + 1];
  if v_uid <> v_spinner then
    return jsonb_build_object('ok', false, 'error', 'not your turn to spin');
  end if;

  v_res := public.resolve_private_round(p_table_id);
  if not coalesce((v_res ->> 'resolved')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'round could not be resolved');
  end if;

  return jsonb_build_object(
    'ok', true,
    'resolved', true,
    'round_no', v_tbl.current_round_no
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- leave_private_table: same as the corrected migration 028 version, minus
-- the auto-resolve; plus the stranded-round refund cleanup.
-- ---------------------------------------------------------------------------
create or replace function public.leave_private_table(
  p_table_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_tbl         public.private_tables%rowtype;
  v_seats_left  int;
  v_bid_count   int;
  v_round_total numeric;
  v_bid         public.private_bids%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;

  select * into v_tbl from public.private_tables where id = p_table_id for update;
  if v_tbl.id is null then
    return jsonb_build_object('ok', false, 'error', 'table not found');
  end if;

  if not exists (
    select 1 from public.private_seats
    where table_id = p_table_id and user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'error', 'you are not seated at this table');
  end if;

  select count(*), coalesce(sum(amount), 0) into v_bid_count, v_round_total
  from public.private_bids
  where table_id = p_table_id and round_no = v_tbl.current_round_no;

  delete from public.private_seats
  where table_id = p_table_id and user_id = v_uid;

  select count(*) into v_seats_left
  from public.private_seats
  where table_id = p_table_id;

  if v_seats_left = 0 then
    -- LAST PLAYER OUT (owner rule): no refunds — the current round's bids
    -- go to the house fee and the table closes.
    update public.private_tables
    set status = 'closed',
        fee_amount = fee_amount + v_round_total
    where id = p_table_id;
  else
    if v_seats_left = 1 and v_bid_count = 1 then
      -- The round can never complete (one player left, one bid): refund
      -- that bid and clear it so the money is not stuck.
      for v_bid in
        select * from public.private_bids
        where table_id = p_table_id and round_no = v_tbl.current_round_no
      loop
        update public.wallets
        set balance = balance + v_bid.amount, updated_at = now()
        where user_id = v_bid.user_id;
        insert into public.transactions (user_id, type, amount, status, note)
        values (v_bid.user_id, 'refund', v_bid.amount, 'completed',
                'Private table round refund');
      end loop;
      delete from public.private_bids
      where table_id = p_table_id and round_no = v_tbl.current_round_no;
    end if;

    update public.private_tables
    set status = case when v_seats_left < 2 then 'waiting' else status end
    where id = p_table_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'seats_left', v_seats_left,
    'status', case
                when v_seats_left = 0 then 'closed'
                when v_seats_left < 2 then 'waiting'
                else v_tbl.status
              end
  );
end;
$$;
