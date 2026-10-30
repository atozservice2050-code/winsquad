-- ============================================================================
-- 031 — Private table bid limits (owner order 2026-10-30):
--   minimum bid Rs 50 (was Rs 500), maximum bid Rs 10,000 (was Rs
--   1,000,000). Quick tabs in the app become Rs 50 / 100 / 500 + Custom.
-- Only the amount validation changes; the rest of place_private_bid is
-- restated unchanged from migration 028. The private_bids table ALSO has
-- its own amount CHECK constraint from the original schema (>= 500) —
-- caught by the boundary test — so it is widened to the same bounds.
-- ============================================================================

alter table public.private_bids
  drop constraint private_bids_amount_check;
alter table public.private_bids
  add constraint private_bids_amount_check
  check (amount >= 50 and amount <= 10000);

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
