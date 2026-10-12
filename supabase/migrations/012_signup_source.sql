-- Migration 012: track where signups come from (apk / mobile-web / desktop-web)
-- so the owner can see which platform brings more users.

alter table public.profiles
  add column if not exists signup_source text;

-- Extend the signup trigger (keeps 006 logic: phone from metadata, Rs 50 bonus).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_source text;
begin
  -- Get phone from metadata (frontend stores it there) or auth phone
  v_phone := coalesce(
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    new.phone
  );

  -- Device source sent by the frontend in signup options.data
  v_source := nullif(new.raw_user_meta_data ->> 'device_source', '');

  insert into public.profiles (id, phone, display_name, signup_source)
  values (
    new.id,
    v_phone,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'Player'),
    v_source
  )
  on conflict (id) do update set
    phone = excluded.phone,
    signup_source = coalesce(public.profiles.signup_source, excluded.signup_source);

  -- Rs 50 welcome bonus for new users
  insert into public.wallets (user_id, balance)
  values (new.id, 50)
  on conflict (user_id) do update set balance = public.wallets.balance + 50;

  insert into public.transactions (user_id, type, amount, status, note)
  values (new.id, 'bonus', 50, 'completed', 'Welcome bonus Rs 50');

  return new;
end;
$$;
