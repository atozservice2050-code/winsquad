-- 036_private_reconnect.sql
-- Owner spec (2026-10-31): a seated private-table player who closes
-- the app does NOT lose their seat at once. Other players see the
-- seat as "connection error" while they are gone; if they return
-- within about a minute they are live again; after that the seat is
-- removed (with exactly the same money rules as a normal leave).
--
-- Presence already exists (migration 033): profiles.last_seen_at is
-- heartbeat-refreshed by every signed-in client. This migration:
--   1. exposes last_seen_at on public_profiles so table clients can
--      render the connection state of each seat;
--   2. adds private_presence_sweep(p_table_id): called by clients
--      viewing a table; removes every seat at that table whose owner
--      has been offline for more than 65 seconds. The caller is never
--      removed by their own sweep.

create or replace view public.public_profiles as
select id, display_name, referral_id, last_seen_at
from public.profiles;

create or replace function public.private_presence_sweep(p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller      uuid := auth.uid();
  v_tbl         public.private_tables%rowtype;
  v_user        uuid;
  v_removed     int := 0;
  v_seats_left  int;
  v_bid_count   int;
  v_round_total numeric;
  v_bid         public.private_bids%rowtype;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;

  select * into v_tbl from public.private_tables where id = p_table_id for update;
  if v_tbl.id is null or v_tbl.status = 'closed' then
    return jsonb_build_object('ok', true, 'removed', 0);
  end if;

  for v_user in
    select s.user_id
    from public.private_seats s
    join public.profiles p on p.id = s.user_id
    where s.table_id = p_table_id
      and s.user_id <> v_caller
      and (p.last_seen_at is null
           or p.last_seen_at < now() - interval '65 seconds')
  loop
    -- Same post-removal money rules as leave_private_table.
    select count(*), coalesce(sum(amount), 0) into v_bid_count, v_round_total
    from public.private_bids
    where table_id = p_table_id and round_no = v_tbl.current_round_no;

    delete from public.private_seats
    where table_id = p_table_id and user_id = v_user;
    v_removed := v_removed + 1;

    select count(*) into v_seats_left
    from public.private_seats where table_id = p_table_id;

    if v_seats_left = 0 then
      -- LAST PLAYER OUT (owner rule): no refunds — the current round's
      -- bids go to the house fee and the table closes.
      update public.private_tables
      set status = 'closed', fee_amount = fee_amount + v_round_total
      where id = p_table_id;
      return jsonb_build_object('ok', true, 'removed', v_removed, 'status', 'closed');
    end if;

    if v_seats_left = 1 and v_bid_count = 1 then
      -- The round can never complete: refund the single bid.
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
    select * into v_tbl from public.private_tables where id = p_table_id;
  end loop;

  return jsonb_build_object('ok', true, 'removed', v_removed);
end;
$$;

revoke all on function public.private_presence_sweep(uuid) from public;
grant execute on function public.private_presence_sweep(uuid) to authenticated;
