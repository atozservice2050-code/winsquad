-- 022: Payment accounts — users save their Easypaisa / JazzCash / Bank
-- accounts in the Wallet ("Add Account"). Used for withdrawal payouts.
-- Run in Supabase SQL editor.

create table if not exists public.payment_accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  type           text not null check (type in ('easypaisa','jazzcash','bank')),
  holder_name    text not null,
  account_number text not null,
  bank_name      text,
  is_primary     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists payment_accounts_user_idx
  on public.payment_accounts (user_id, created_at);

-- At most one primary account per user
create unique index if not exists payment_accounts_one_primary_idx
  on public.payment_accounts (user_id) where is_primary;

alter table public.payment_accounts enable row level security;

drop policy if exists "payment_accounts_select_own" on public.payment_accounts;
create policy "payment_accounts_select_own"
  on public.payment_accounts for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "payment_accounts_insert_own" on public.payment_accounts;
create policy "payment_accounts_insert_own"
  on public.payment_accounts for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "payment_accounts_update_own" on public.payment_accounts;
create policy "payment_accounts_update_own"
  on public.payment_accounts for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "payment_accounts_delete_own" on public.payment_accounts;
create policy "payment_accounts_delete_own"
  on public.payment_accounts for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.payment_accounts to authenticated;
