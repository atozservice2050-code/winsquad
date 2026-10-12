-- 009: Missions — one-time claimable rewards via secure RPC.

create table if not exists public.mission_claims (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  mission_id text not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, mission_id)
);

alter table public.mission_claims enable row level security;

drop policy if exists "mission_claims_select_own" on public.mission_claims;
create policy "mission_claims_select_own"
  on public.mission_claims for select to authenticated
  using (auth.uid() = user_id);

-- Claim a mission reward once. Server-side reward table (source of truth).
create or replace function public.claim_mission(p_mission_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_amount numeric(12,2);
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;

  case p_mission_id
    when 'first_bid'     then v_amount := 50;
    when 'lucky_streak'  then v_amount := 100;
    when 'daily_visitor' then v_amount := 10;
    when 'high_roller'   then v_amount := 200;
    when 'social_star'   then v_amount := 500;
    else return jsonb_build_object('ok', false, 'error', 'unknown mission');
  end case;

  -- Idempotent: already claimed -> report it.
  if exists (select 1 from public.mission_claims
             where user_id = v_uid and mission_id = p_mission_id) then
    return jsonb_build_object('ok', false, 'error', 'already claimed');
  end if;

  insert into public.mission_claims (user_id, mission_id)
  values (v_uid, p_mission_id)
  on conflict do nothing;

  update public.wallets
  set balance = balance + v_amount, updated_at = now()
  where user_id = v_uid;

  insert into public.transactions (user_id, type, amount, status, method, note)
  values (v_uid, 'bonus', v_amount, 'completed', 'wallet',
          'Mission reward: ' || p_mission_id);

  return jsonb_build_object('ok', true, 'mission_id', p_mission_id, 'amount', v_amount);
end;
$$;

revoke all on function public.claim_mission(text) from public;
grant execute on function public.claim_mission(text) to authenticated;
