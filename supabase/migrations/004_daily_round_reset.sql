-- Migration: Daily round number reset at midnight PKT
-- Rounds reset to 1,2,3... each day at 12:00 AM

-- Update get_current_round to reset round_no daily
create or replace function public.get_current_round()
returns public.public_rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_round public.public_rounds%rowtype;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_last_date date;
  v_next_no integer;
begin
  perform public.resolve_due_rounds();

  select id into v_id
  from public.rounds
  where status = 'open'
  order by starts_at desc
  limit 1;

  if v_id is null then
    -- serialize round creation across concurrent callers
    perform pg_advisory_xact_lock(hashtext('winsquad_current_round'));
    select id into v_id from public.rounds where status = 'open' limit 1;
    if v_id is null then
      -- Check if last round was from a previous day (PKT)
      select (starts_at at time zone 'Asia/Karachi')::date into v_last_date
      from public.rounds
      order by starts_at desc
      limit 1;

      if v_last_date is null or v_last_date < v_today then
        -- New day: start from 1
        v_next_no := 1;
      else
        -- Same day: increment from last
        select coalesce(max(round_no), 0) + 1 into v_next_no
        from public.rounds
        where (starts_at at time zone 'Asia/Karachi')::date = v_today;
      end if;

      insert into public.rounds (round_no, starts_at, ends_at, status)
      values (v_next_no, now(), now() + interval '30 seconds', 'open')
      returning id into v_id;
    end if;
  end if;

  select * into v_round from public.public_rounds where id = v_id;
  if v_round.id is null then
    raise exception 'round vanished unexpectedly';
  end if;
  return v_round;
end;
$$;
