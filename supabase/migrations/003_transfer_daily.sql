-- Migration: Change internal transfer from once per 7 days to once per day
-- Updates the transfer_funds RPC cooldown

create or replace function public.transfer_funds(p_to_transfer_id text, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_recipient uuid;
  v_balance numeric(12,2);
  v_max numeric(12,2);
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_to_transfer_id is null or p_to_transfer_id !~ '^\d{14}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid transfer ID (must be 14 digits)');
  end if;
  if p_amount is null or p_amount < 500 then
    return jsonb_build_object('ok', false, 'error', 'minimum transfer is Rs 500');
  end if;
  if p_amount > 10000 then
    return jsonb_build_object('ok', false, 'error', 'maximum transfer is Rs 10,000');
  end if;

  select id into v_recipient from public.profiles where transfer_id = p_to_transfer_id;
  if v_recipient is null then
    return jsonb_build_object('ok', false, 'error', 'recipient not found');
  end if;
  if v_recipient = v_uid then
    return jsonb_build_object('ok', false, 'error', 'cannot transfer to yourself');
  end if;

  -- Once per DAY (changed from 7 days)
  if exists (
    select 1 from public.transactions
    where user_id = v_uid
      and type in ('transfer_out', 'transfer')
      and created_at > now() - interval '1 day'
  ) then
    return jsonb_build_object('ok', false, 'error', 'only 1 transfer per day allowed');
  end if;

  select balance into v_balance from public.wallets where user_id = v_uid for update;
  if v_balance is null then
    return jsonb_build_object('ok', false, 'error', 'wallet not found');
  end if;
  v_max := floor(v_balance * 0.5);
  if p_amount > v_max then
    return jsonb_build_object('ok', false, 'error', 'amount exceeds 50% of balance');
  end if;
  if p_amount > v_balance then
    return jsonb_build_object('ok', false, 'error', 'insufficient balance');
  end if;

  update public.wallets set balance = balance - p_amount, updated_at = now() where user_id = v_uid;
  update public.wallets set balance = balance + p_amount, updated_at = now() where user_id = v_recipient;

  insert into public.transactions (user_id, type, amount, status, counterparty_user_id, note)
  values
    (v_uid,       'transfer_out', p_amount, 'completed', v_recipient, 'Transfer to ' || p_to_transfer_id),
    (v_recipient, 'transfer_in',  p_amount, 'completed', v_uid,       'Transfer from user');

  return jsonb_build_object('ok', true, 'amount', p_amount);
end;
$$;
