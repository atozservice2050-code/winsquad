-- ============================================================================
-- 033 — Presence (owner order 2026-10-30): the admin wants to KNOW when a
-- player comes online — a live online view in the admin portal plus a
-- notification for every offline -> online arrival.
--   * profiles.last_seen_at, kept fresh by touch_presence() (the app
--     calls it on entry and every ~30s; writes throttled to 20s).
--   * presence_events: one row per arrival, written by a trigger when
--     last_seen_at jumps from stale (> 2 min) / null to fresh.
--   * Admin portal polls: online-now counter (last_seen within 90s),
--     green dots + last-seen per user, toast + sound + activity feed
--     for new presence_events.
-- ============================================================================

alter table public.profiles
  add column if not exists last_seen_at timestamptz;

create or replace function public.touch_presence()
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
  update public.profiles
  set last_seen_at = now()
  where id = v_uid
    and (last_seen_at is null or last_seen_at < now() - interval '20 seconds');
  return jsonb_build_object('ok', true);
end;
$$;

create table if not exists public.presence_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  came_online_at timestamptz not null default now()
);

alter table public.presence_events enable row level security;

drop policy if exists presence_events_admin_read on public.presence_events;
create policy presence_events_admin_read
  on public.presence_events for select to authenticated
  using (public.is_admin());

create or replace function public.log_came_online()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_seen_at is not null
     and (old.last_seen_at is null
          or old.last_seen_at < now() - interval '2 minutes') then
    insert into public.presence_events (user_id) values (new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_came_online on public.profiles;
create trigger trg_profiles_came_online
  after update of last_seen_at on public.profiles
  for each row execute function public.log_came_online();
