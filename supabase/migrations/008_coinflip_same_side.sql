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
