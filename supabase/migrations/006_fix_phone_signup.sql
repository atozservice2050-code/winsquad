-- Migration: Fix phone number saving on signup
-- The trigger was reading new.phone (null for email auth)
-- Now reads from raw_user_meta_data where frontend stores it

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
begin
  -- Get phone from metadata (frontend stores it there) or auth phone
  v_phone := coalesce(
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    new.phone
  );

  insert into public.profiles (id, phone, display_name)
  values (
    new.id,
    v_phone,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'Player')
  )
  on conflict (id) do update set phone = excluded.phone;

  -- Rs 50 welcome bonus for new users
  insert into public.wallets (user_id, balance)
  values (new.id, 50)
  on conflict (user_id) do update set balance = public.wallets.balance + 50;

  insert into public.transactions (user_id, type, amount, status, note)
  values (new.id, 'bonus', 50, 'completed', 'Welcome bonus Rs 50');

  return new;
end;
$$;

-- Backfill: extract phone from plus-addressed email for existing users
-- Email format: atozservice2050+923001234567@gmail.com
update public.profiles p
set phone = substring(u.email from '\+(\d+)@')
from auth.users u
where p.id = u.id
  and (p.phone is null or p.phone = '')
  and u.email ~ '\+\d+@';
