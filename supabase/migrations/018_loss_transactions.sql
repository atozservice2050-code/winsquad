-- 018: Loss ledger rows — wallet transaction history records losses.
--
-- ROOT CAUSE of "transaction history fake hai": resolve functions only wrote
-- transaction rows for bets, wins and refunds. Losses were marked on the bid
-- rows (is_winner=false / top-2 classification) but NEVER got a transaction
-- row, so lost money simply vanished from the wallet history with no entry.
-- Now every loser in every game gets an explicit *_loss transaction row.
--
-- Run in the Supabase SQL editor. Safe to re-run (CREATE OR REPLACE).

create or replace function public.resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round      public.rounds%rowtype;
  v_bid        record;
  v_rank       int := 0;
  v_n          int := 0;
  v_winners    int := 0;
  v_losers     numeric(12,2) := 0;
  v_loser_ids  uuid[] := '{}';
  v_wtot       numeric(12,2) := 0;
  v_fee        numeric(12,2);
  v_dist       numeric(12,2);
  v_payout     numeric(12,2);
  v_paid       numeric(12,2) := 0;
begin
  if p_round_id is null then
    return jsonb_build_object('ok', false, 'error', 'round id required');
  end if;

  perform pg_advisory_xact_lock(hashtext('winsquad_resolve_' || p_round_id::text));

  update public.rounds
  set status = 'resolving', updated_at = now()
  where id = p_round_id and status = 'open'
  returning * into v_round;

  if not found then
    -- idempotent no-op
    select * into v_round from public.rounds where id = p_round_id;
    if v_round.id is null then
      return jsonb_build_object('ok', false, 'error', 'round not found');
    end if;
    if v_round.status = 'closed' then
      return jsonb_build_object('ok', true, 'already_closed', true,
                                'round_no', v_round.round_no);
    end if;
    return jsonb_build_object('ok', false, 'error', 'round is not open');
  end if;

  select count(*) into v_n from public.bids where round_id = p_round_id;

  if v_n < 3 then
    -- not enough players: refund PAID bids only (free bids staked nothing),
    -- no fee, no winners
    for v_bid in
      select user_id, amount from public.bids
      where round_id = p_round_id and not is_free
    loop
      update public.wallets
      set balance = balance + v_bid.amount, updated_at = now()
      where user_id = v_bid.user_id;
      insert into public.transactions (user_id, type, amount, status, note)
      values (v_bid.user_id, 'payout', v_bid.amount, 'completed',
              'Refund: round #' || v_round.round_no || ' cancelled (not enough players)');
    end loop;
    update public.rounds set status = 'closed', updated_at = now()
    where id = p_round_id;
    return jsonb_build_object('ok', true, 'round_no', v_round.round_no,
                              'cancelled', true, 'refunded', v_n);
  end if;

  -- classify: first 2 rows of (amount DESC, placed_at ASC) lose
  for v_bid in
    select user_id, amount
    from public.bids
    where round_id = p_round_id
    order by amount desc, placed_at asc
  loop
    v_rank := v_rank + 1;
    if v_rank <= 2 then
      v_losers    := v_losers + v_bid.amount;
      v_loser_ids := v_loser_ids || v_bid.user_id;
    else
      v_wtot    := v_wtot + v_bid.amount;
      v_winners := v_winners + 1;
    end if;
  end loop;

  v_fee  := floor(v_losers * 0.10 * 100) / 100;
  v_dist := v_losers - v_fee;

  -- pay winners proportionally (floored to 2dp); write public leaderboard rows
  for v_bid in
    select user_id, amount
    from public.bids
    where round_id = p_round_id
      and not (user_id = any (v_loser_ids))
    order by placed_at asc
  loop
    v_payout := floor((v_dist * v_bid.amount / v_wtot) * 100) / 100;
    v_paid   := v_paid + v_payout;

    update public.wallets
    set balance = balance + v_payout, updated_at = now()
    where user_id = v_bid.user_id;

    insert into public.transactions (user_id, type, amount, status, note)
    values (v_bid.user_id, 'payout', v_payout, 'completed',
            'Squad Stakes round #' || v_round.round_no || ' winnings');

    insert into public.round_results (round_id, user_id, bid_amount, payout)
    values (p_round_id, v_bid.user_id, v_bid.amount, v_payout);
  end loop;

  -- LOSS LEDGER (018): every loser gets an explicit transaction row so the
  -- wallet history accounts for lost stakes.
  for v_bid in
    select user_id, amount
    from public.bids
    where round_id = p_round_id
      and not is_free
      and user_id = any (v_loser_ids)
  loop
    insert into public.transactions (user_id, type, amount, status, note)
    values (v_bid.user_id, 'squad_loss', v_bid.amount, 'completed',
            'Squad Stakes round #' || v_round.round_no || ' - lost Rs ' ||
            v_bid.amount::text);
  end loop;

  -- rounding dust goes to the house fee; fee stays HIDDEN on rounds
  update public.rounds
  set status     = 'closed',
      updated_at = now(),
      fee_amount = fee_amount + v_fee + (v_dist - v_paid)
  where id = p_round_id;

  return jsonb_build_object(
    'ok', true,
    'round_no', v_round.round_no,
    'winners', v_winners,
    'losers_pool', v_losers,
    'total_payout', v_paid
  );
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

  if v_n < 4 then
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

  -- LOSS LEDGER (018): the single loser gets an explicit transaction row.
  insert into public.transactions (user_id, type, amount, status, note)
  values (v_loser_id, 'squad_loss', v_loser_amt, 'completed',
          'Private table round ' || v_rno || ' - lost Rs ' || v_loser_amt::text);

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

-- 008: Coin Flip same-side rule — if all real players on one side, they LOSE (no refund).
create or replace function public.cf_resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round   public.cf_rounds%rowtype;
  v_h       numeric(12,2);
  v_t       numeric(12,2);
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

  select * into v_round from public.cf_rounds where id = p_round_id for update;
  if v_round.id is null then
    return jsonb_build_object('ok', false, 'error', 'round not found');
  end if;
  if v_round.status <> 'open' then
    return jsonb_build_object('ok', true, 'already_closed', true,
                              'winning_side', v_round.winning_side);
  end if;

  update public.cf_rounds set status = 'resolving', updated_at = now()
  where id = p_round_id;

  select coalesce(sum(amount) filter (where side = 'heads'), 0),
         coalesce(sum(amount) filter (where side = 'tails'), 0)
  into v_h, v_t
  from public.cf_bids
  where round_id = p_round_id;

  -- SAME-SIDE RULE: all players on one side -> they ALL LOSE (money to company).
  -- No refund. The empty side "wins" by default.
  if v_h = 0 or v_t = 0 then
    -- Mark all as losers, company keeps everything
    update public.cf_bids
    set is_winner = false, payout = 0
    where round_id = p_round_id;

    -- LOSS LEDGER (018): same-side losers get explicit transaction rows.
    for r in select user_id, amount from public.cf_bids
             where round_id = p_round_id
    loop
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'coinflip_loss', r.amount, 'completed', 'wallet',
              'Coin Flip round #' || v_round.round_no ||
              ' - all players on one side - lost Rs ' || r.amount::text);
    end loop;

    v_fee := v_h + v_t; -- company keeps all

    update public.cf_rounds
    set status = 'closed',
        winning_side = case when v_h = 0 then 'tails' else 'heads' end,
        fee_amount = v_fee,
        heads_total = v_h, tails_total = v_t, updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'same_side_loss', true,
                              'winning_side', case when v_h = 0 then 'tails' else 'heads' end,
                              'heads_total', v_h, 'tails_total', v_t,
                              'fee', v_fee);
  end if;

  -- Tie -> refund everybody (unchanged)
  if v_h = v_t then
    for r in select user_id, amount from public.cf_bids
             where round_id = p_round_id and not refunded
    loop
      update public.wallets
      set balance = balance + r.amount, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'payout', r.amount, 'completed', 'wallet',
              'Coin Flip round #' || v_round.round_no || ' cancelled — bid refunded');
      update public.cf_bids
      set refunded = true, is_winner = false, payout = 0
      where round_id = p_round_id and user_id = r.user_id;
    end loop;

    update public.cf_rounds
    set status = 'closed', winning_side = null, fee_amount = 0,
        heads_total = v_h, tails_total = v_t, updated_at = now()
    where id = p_round_id;

    return jsonb_build_object('ok', true, 'cancelled', true,
                              'heads_total', v_h, 'tails_total', v_t);
  end if;

  -- Lower-total side wins (unchanged from here)
  if v_h < v_t then
    v_wside := 'heads'; v_wtotal := v_h; v_ltotal := v_t;
  else
    v_wside := 'tails'; v_wtotal := v_t; v_ltotal := v_h;
  end if;

  if v_ltotal >= 2 * v_wtotal then
    for r in select user_id, amount from public.cf_bids
             where round_id = p_round_id and side = v_wside
             order by placed_at
    loop
      v_payout := round(r.amount * 2, 2);
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'coinflip_win', v_payout, 'completed', 'wallet',
              'Coin Flip round #' || v_round.round_no || ' · ' ||
              upper(v_wside) || ' wins · 2x payout');
      update public.cf_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
    end loop;
    v_fee := v_ltotal - v_paid;
  else
    for r in select user_id, amount from public.cf_bids
             where round_id = p_round_id and side = v_wside
             order by placed_at
    loop
      v_payout := floor(r.amount / v_wtotal * v_ltotal * 100) / 100;
      v_paid := v_paid + v_payout;
      update public.wallets
      set balance = balance + v_payout, updated_at = now()
      where user_id = r.user_id;
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'coinflip_win', v_payout, 'completed', 'wallet',
              'Coin Flip round #' || v_round.round_no || ' · ' ||
              upper(v_wside) || ' wins · proportional');
      update public.cf_bids
      set is_winner = true, payout = v_payout
      where round_id = p_round_id and user_id = r.user_id;
    end loop;
    v_fee := v_ltotal - v_paid;
  end if;

  -- LOSS LEDGER (018): losers get explicit transaction rows.
  for r in select user_id, amount from public.cf_bids
           where round_id = p_round_id and side <> v_wside
  loop
    insert into public.transactions (user_id, type, amount, status, method, note)
    values (r.user_id, 'coinflip_loss', r.amount, 'completed', 'wallet',
            'Coin Flip round #' || v_round.round_no || ' - ' ||
            upper(v_wside) || ' wins - lost Rs ' || r.amount::text);
  end loop;

  -- Mark losers
  update public.cf_bids
  set is_winner = false, payout = 0
  where round_id = p_round_id and side <> v_wside;

  update public.cf_rounds
  set status = 'closed', winning_side = v_wside, fee_amount = v_fee,
      heads_total = v_h, tails_total = v_t, updated_at = now()
  where id = p_round_id;

  return jsonb_build_object('ok', true, 'winning_side', v_wside,
                            'heads_total', v_h, 'tails_total', v_t,
                            'fee', v_fee);
end;
$$;


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

    -- LOSS LEDGER (018): same-side losers get explicit transaction rows.
    for r in select user_id, amount from public.dt_bids
             where round_id = p_round_id
    loop
      insert into public.transactions (user_id, type, amount, status, method, note)
      values (r.user_id, 'dragontiger_loss', r.amount, 'completed', 'wallet',
              'Dragon Tiger round #' || v_round.round_no ||
              ' - all players on one side - lost Rs ' || r.amount::text);
    end loop;

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

  -- LOSS LEDGER (018): losers get explicit transaction rows.
  for r in select user_id, amount from public.dt_bids
           where round_id = p_round_id and side <> v_wside
  loop
    insert into public.transactions (user_id, type, amount, status, method, note)
    values (r.user_id, 'dragontiger_loss', r.amount, 'completed', 'wallet',
            'Dragon Tiger round #' || v_round.round_no || ' - ' ||
            upper(v_wside) || ' wins - lost Rs ' || r.amount::text);
  end loop;

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
        -- LOSS LEDGER (018): losing bets get explicit transaction rows.
        insert into public.transactions (user_id, type, amount, status, method, note)
        values (r.user_id, 'roulette_loss', r.amount, 'completed', 'wallet',
                'Roulette round #' || v_round.round_no || ' - number ' || v_win ||
                ' - ' || r.bet_type ||
                case when r.bet_type = 'straight' then ' ' || r.bet_value else '' end ||
                ' lost - lost Rs ' || r.amount::text);
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
