-- Migration: Update referral bonuses + add signup bonus
-- New user signup: Rs 50
-- Referral: Inviter Rs 500, Joiner Rs 100

-- 1. Update apply_referral: Rs 500 for inviter, Rs 100 for joiner
create or replace function public.apply_referral(p_referral_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_referrer uuid;
  v_joiner_bonus    constant numeric(12,2) := 100;
  v_inviter_bonus   constant numeric(12,2) := 500;
  v_first    uuid;
  v_second   uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_referral_id is null or trim(p_referral_id) = '' then
    return jsonb_build_object('ok', false, 'error', 'referral code required');
  end if;

  if exists (select 1 from public.profiles where id = v_uid and referred_by is not null) then
    return jsonb_build_object('ok', false, 'error', 'referral already applied');
  end if;

  select id into v_referrer
  from public.profiles
  where referral_id = upper(trim(p_referral_id));

  if v_referrer is null then
    return jsonb_build_object('ok', false, 'error', 'invalid referral code');
  end if;
  if v_referrer = v_uid then
    return jsonb_build_object('ok', false, 'error', 'cannot refer yourself');
  end if;

  update public.profiles set referred_by = v_referrer where id = v_uid;

  if v_uid < v_referrer then
    v_first := v_uid; v_second := v_referrer;
  else
    v_first := v_referrer; v_second := v_uid;
  end if;
  perform 1 from public.wallets where user_id = v_first  for update;
  perform 1 from public.wallets where user_id = v_second for update;

  -- Joiner gets Rs 100
  update public.wallets
  set balance = balance + v_joiner_bonus, updated_at = now()
  where user_id = v_uid;
  -- Inviter gets Rs 500
  update public.wallets
  set balance = balance + v_inviter_bonus, updated_at = now()
  where user_id = v_referrer;

  insert into public.rewards (user_id, type, amount, meta)
  values
    (v_uid,      'referral', v_joiner_bonus,
     jsonb_build_object('direction', 'received', 'counterparty', v_referrer)),
    (v_referrer, 'referral', v_inviter_bonus,
     jsonb_build_object('direction', 'earned',   'counterparty', v_uid));

  insert into public.transactions (user_id, type, amount, status, counterparty_user_id, note)
  values
    (v_uid,      'bonus', v_joiner_bonus,  'completed', v_referrer, 'Referral join bonus Rs 100'),
    (v_referrer, 'bonus', v_inviter_bonus, 'completed', v_uid,      'Referral invite bonus Rs 500');

  return jsonb_build_object('ok', true, 'joiner_bonus', v_joiner_bonus, 'inviter_bonus', v_inviter_bonus);
end;
$$;

-- 2. Add Rs 50 signup bonus in handle_new_user trigger
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, phone, display_name)
  values (
    new.id,
    new.phone,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'Player')
  )
  on conflict (id) do nothing;

  -- Rs 50 welcome bonus for new users
  insert into public.wallets (user_id, balance)
  values (new.id, 50)
  on conflict (user_id) do update set balance = public.wallets.balance + 50;

  insert into public.transactions (user_id, type, amount, status, note)
  values (new.id, 'bonus', 50, 'completed', 'Welcome bonus Rs 50');

  return new;
end;
$$;
