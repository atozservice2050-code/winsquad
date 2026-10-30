-- ============================================================================
-- 034 — Push notification device tokens (owner order 2026-10-30: real
-- push notifications with a rebuilt APK). The Android shell (v2) gets an
-- FCM token from Firebase and the web app registers it against the
-- signed-in user via register_push_token(). A server-side sender (with
-- the service role key) reads tokens from this table and sends via FCM.
-- ============================================================================

create table if not exists public.user_push_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  token      text not null unique,
  platform   text not null default 'android',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_push_tokens_user
  on public.user_push_tokens (user_id);

alter table public.user_push_tokens enable row level security;

drop policy if exists push_tokens_own_read on public.user_push_tokens;
create policy push_tokens_own_read
  on public.user_push_tokens for select to authenticated
  using (user_id = auth.uid());

drop policy if exists push_tokens_own_delete on public.user_push_tokens;
create policy push_tokens_own_delete
  on public.user_push_tokens for delete to authenticated
  using (user_id = auth.uid());

create or replace function public.register_push_token(
  p_token    text,
  p_platform text default 'android'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_token is null or length(trim(p_token)) < 10 then
    return jsonb_build_object('ok', false, 'error', 'invalid token');
  end if;

  -- A token belongs to one account at a time (device may switch users).
  delete from public.user_push_tokens
  where token = p_token and user_id <> v_uid;

  insert into public.user_push_tokens (user_id, token, platform)
  values (v_uid, p_token, coalesce(p_platform, 'android'))
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;
