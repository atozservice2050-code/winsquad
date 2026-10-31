-- ============================================================================
-- 035 — Roulette draw rewrite (owner order 2026-10-31): results were
-- visibly repeating (the old picker chose among the same 6 lowest-
-- liability numbers every round, so recent results cycled through a
-- tiny set — a catchable, exploitable pattern).
--
-- New draw properties:
--   * Looks fully random: the candidate pool is the cheaper ~55% of
--     numbers by payout liability, but each round a random jitter is
--     added before ranking, so pool membership changes every round
--     even when the bets are identical. No fixed pattern exists.
--   * The round's BIGGEST bettor can never be the winner: any number
--     where that player would take >= half of the total payout is
--     forbidden. In a one-player round this means he can never win
--     at all (falls back to company-safe numbers only if every
--     number would pay him).
--   * The previous round's winning number is excluded when the pool
--     stays wide enough — no immediate repeats.
--   * Company protection is unchanged: the most expensive numbers
--     (top ~45% by liability) are never drawn.
-- ============================================================================

create or replace function public.roulette_pick_number(p_round_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidates text[] := array[
    '0','00','1','2','3','4','5','6','7','8','9','10','11','12','13','14',
    '15','16','17','18','19','20','21','22','23','24','25','26','27','28',
    '29','30','31','32','33','34','35','36'];
  v_total numeric := 0;
  v_jitter numeric;
  v_last  text;
  v_best  text;
begin
  if p_round_id is null then
    return v_candidates[1 + floor(random() * 38)::int];
  end if;

  select coalesce(sum(amount), 0) into v_total
  from public.roulette_bids
  where round_id = p_round_id;

  -- Previous winner (for the anti-repeat rule).
  select winning_number into v_last
  from public.roulette_rounds
  where id <> p_round_id
    and winning_number is not null
  order by created_at desc
  limit 1;

  if v_total <= 0 then
    -- No real bets this round: pure random, avoid an immediate repeat.
    select n into v_best
    from unnest(v_candidates) as n
    where n <> coalesce(v_last, '')
    order by random()
    limit 1;
    return coalesce(v_best, v_candidates[1 + floor(random() * 38)::int]);
  end if;

  -- Jitter scales with the round size so the pool changes every round.
  v_jitter := greatest(v_total * 0.35, 100);

  with top_bettor as (
    select user_id
    from public.roulette_bids
    where round_id = p_round_id
    group by user_id
    order by sum(amount) desc
    limit 1
  ),
  liab as (
    select c.n as num,
           coalesce(sum(b.amount *
             public.roulette_bet_multiplier(b.bet_type, b.bet_value, c.n)), 0)
             as liability,
           coalesce(sum(b.amount *
             public.roulette_bet_multiplier(b.bet_type, b.bet_value, c.n))
             filter (where b.user_id = (select user_id from top_bettor)), 0)
             as top_liab
    from unnest(v_candidates) as c(n)
    left join public.roulette_bids b on b.round_id = p_round_id
    group by c.n
  ),
  scored as (
    select num, liability,
           liability + random() * v_jitter as score,
           (top_liab > 0 and top_liab >= liability * 0.5) as forbidden
    from liab
  ),
  ranked as (
    select num, forbidden,
           percent_rank() over (order by score) as pr
    from scored
  ),
  pool as (
    select num from ranked where pr <= 0.55 and not forbidden
  ),
  pool_nr as (
    -- pool without the previous winner, if it stays wide enough
    select num from pool where num <> coalesce(v_last, '')
  )
  select num into v_best
  from (
    select num, 1 as grp from pool_nr
    union all
    select num, 2 as grp from pool
  ) s
  where grp = (case when (select count(*) from pool_nr) >= 8 then 1 else 2 end)
  order by random()
  limit 1;

  if v_best is null then
    -- Every cheap number would pay the biggest bettor: fall back to
    -- the single cheapest number for the company.
    select c.n into v_best
    from unnest(v_candidates) as c(n)
    left join public.roulette_bids b on b.round_id = p_round_id
    group by c.n
    order by coalesce(sum(b.amount *
      public.roulette_bet_multiplier(b.bet_type, b.bet_value, c.n)), 0) asc,
      random()
    limit 1;
  end if;

  return coalesce(v_best, v_candidates[1 + floor(random() * 38)::int]);
end;
$$;
