-- ============================================================================
-- 029 — Private tables: minimum players 3 -> 2 (owner order 2026-10-30).
--
-- "Private table py 2 log bhi active hon toh bhi game live chalni
-- chahiye — rule wohi, zyada bid wala lose karega." A 2-player table now
-- plays: the higher bidder loses, the other player takes 90% of the
-- loser's bid (10% house fee, as always). Everything else is unchanged:
-- tables still seat up to 4, a round completes when every seated player
-- has bid. Apply AFTER 028 (028 carries the min-2 thresholds for
-- resolve_private_round / leave_private_table / place_private_bid; this
-- file updates join_private_table + backfills stuck tables).
-- ============================================================================

-- Join: activate when the 2nd seat fills (was: 3rd).
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

  if v_n + 1 >= 2 then
    update public.private_tables set status = 'active' where id = v_tbl.id;
    v_tbl.status := 'active';
  end if;

  return jsonb_build_object('ok', true, 'table_id', v_tbl.id,
                            'seat_no', v_seat, 'status', v_tbl.status);
end;
$$;

-- Backfill: activate waiting tables that already have 2+ seated players.
update public.private_tables t
set status = 'active'
where t.status = 'waiting'
  and (select count(*) from public.private_seats s where s.table_id = t.id) >= 2;
