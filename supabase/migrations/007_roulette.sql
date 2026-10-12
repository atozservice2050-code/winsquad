-- Migration: REAL Roulette game backend
-- roulette_spin(p_bets jsonb): atomic, server-side spin.
-- p_bets: array of {kind, value, amount}
--   kind: 'number' (value 0-36), 'red', 'black', 'odd', 'even', 'low' (1-18), 'high' (19-36)
-- Deducts total bet, rolls winning number 0-36 server-side, credits payout.
-- Uses existing transaction types: 'stake' (bet) and 'payout' (win).

create or replace function public.roulette_spin(p_bets jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_bet     jsonb;
  v_kind    text;
  v_num     int;
  v_amt     numeric(12,2);
  v_total   numeric(12,2) := 0;
  v_balance numeric(12,2);
  v_win     int;
  v_color   text;
  v_payout  numeric(12,2) := 0;
  v_p       numeric(12,2);
  v_reds    int[] := array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_bets is null or jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 then
    return jsonb_build_object('ok', false, 'error', 'place at least one bet');
  end if;
  if jsonb_array_length(p_bets) > 20 then
    return jsonb_build_object('ok', false, 'error', 'too many bets (max 20)');
  end if;

  -- validate bets and total them
  for v_bet in select * from jsonb_array_elements(p_bets) loop
    v_kind := v_bet ->> 'kind';
    v_amt  := round(coalesce((v_bet ->> 'amount')::numeric, 0), 2);
    if v_kind not in ('number','red','black','odd','even','low','high') then
      return jsonb_build_object('ok', false, 'error', 'invalid bet type');
    end if;
    if v_amt < 10 then
      return jsonb_build_object('ok', false, 'error', 'minimum bet is Rs 10');
    end if;
    if v_amt > 50000 then
      return jsonb_build_object('ok', false, 'error', 'bet too large');
    end if;
    if v_kind = 'number' then
      v_num := (v_bet ->> 'value')::int;
      if v_num is null or v_num < 0 or v_num > 36 then
        return jsonb_build_object('ok', false, 'error', 'invalid number (0-36)');
      end if;
    end if;
    v_total := v_total + v_amt;
  end loop;
  if v_total <= 0 then
    return jsonb_build_object('ok', false, 'error', 'place at least one bet');
  end if;

  -- lock wallet, check balance, deduct stake
  select balance into v_balance from public.wallets where user_id = v_uid for update;
  if v_balance is null then
    return jsonb_build_object('ok', false, 'error', 'wallet not found');
  end if;
  if v_total > v_balance then
    return jsonb_build_object('ok', false, 'error', 'insufficient balance');
  end if;
  update public.wallets set balance = balance - v_total, updated_at = now()
  where user_id = v_uid;
  insert into public.transactions (user_id, type, amount, status, note)
  values (v_uid, 'stake', v_total, 'completed', 'Roulette bet');

  -- spin: random winning number 0-36
  v_win := floor(random() * 37)::int;
  if v_win = 0 then
    v_color := 'green';
  elsif v_win = any(v_reds) then
    v_color := 'red';
  else
    v_color := 'black';
  end if;

  -- payouts: single number 35:1, outside bets 1:1
  for v_bet in select * from jsonb_array_elements(p_bets) loop
    v_kind := v_bet ->> 'kind';
    v_amt  := round(coalesce((v_bet ->> 'amount')::numeric, 0), 2);
    v_p := 0;
    if v_kind = 'number' and (v_bet ->> 'value')::int = v_win then
      v_p := v_amt * 36;                 -- 35:1 + stake back
    elsif v_kind = 'red'   and v_color = 'red' then
      v_p := v_amt * 2;
    elsif v_kind = 'black' and v_color = 'black' then
      v_p := v_amt * 2;
    elsif v_kind = 'odd'   and v_win <> 0 and v_win % 2 = 1 then
      v_p := v_amt * 2;
    elsif v_kind = 'even'  and v_win <> 0 and v_win % 2 = 0 then
      v_p := v_amt * 2;
    elsif v_kind = 'low'   and v_win between 1 and 18 then
      v_p := v_amt * 2;
    elsif v_kind = 'high'  and v_win between 19 and 36 then
      v_p := v_amt * 2;
    end if;
    v_payout := v_payout + v_p;
  end loop;

  if v_payout > 0 then
    update public.wallets set balance = balance + v_payout, updated_at = now()
    where user_id = v_uid;
    insert into public.transactions (user_id, type, amount, status, note)
    values (v_uid, 'payout', v_payout, 'completed',
            'Roulette win: ' || v_win || ' ' || v_color);
  end if;

  return jsonb_build_object(
    'ok', true,
    'winning_number', v_win,
    'color', v_color,
    'total_bet', v_total,
    'total_payout', v_payout,
    'profit', v_payout - v_total
  );
end;
$$;

-- lock down: authenticated users only (new functions default to PUBLIC execute)
do $$
declare
  v_sig text;
begin
  for v_sig in
    select 'public.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'roulette_spin'
  loop
    execute 'revoke all on function ' || v_sig || ' from public';
    execute 'grant execute on function ' || v_sig || ' to authenticated';
  end loop;
end
$$;
