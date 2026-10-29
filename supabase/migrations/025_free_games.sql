-- 025: Free fun games (Mines / Memory Match / Flappy Jump) — LEVEL system.
--   * Progress is stored server-side: one row per (user, game) with the
--     player's CURRENT level. Winning is claimed through
--     claim_free_game_win(), which pays the reward for the stored level
--     and only then advances the level — a finished level can never be
--     farmed twice, and levels cannot be skipped.
--   * Reward: Rs 20 at level 1, +Rs 5 per level, capped at Rs 50.
--   * The reward is inserted as a transactions row type='bonus', so the
--     024 bonus-wallet trigger locks it automatically (unlocks by playing).
-- Run in Supabase SQL editor (after 024).

create table if not exists public.free_game_progress (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  game       text not null check (game in ('mines','memory','flappy')),
  level      int  not null default 1 check (level >= 1),
  total_won  numeric(12,2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, game)
);

alter table public.free_game_progress enable row level security;
drop policy if exists "fgp_select_own" on public.free_game_progress;
create policy "fgp_select_own" on public.free_game_progress
  for select using (auth.uid() = user_id);

-- Claim a win at the player's stored level for a game.
create or replace function public.claim_free_game_win(p_game text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_level int;
  v_reward numeric(12,2);
  v_label text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_game not in ('mines','memory','flappy') then
    return jsonb_build_object('ok', false, 'error', 'unknown game');
  end if;
  v_label := case p_game when 'mines' then 'Mines'
                         when 'memory' then 'Memory Match'
                         else 'Flappy Jump' end;

  insert into public.free_game_progress (user_id, game)
  values (v_uid, p_game)
  on conflict (user_id, game) do nothing;

  select level into v_level
  from public.free_game_progress
  where user_id = v_uid and game = p_game
  for update;

  v_reward := least(15 + 5 * v_level, 50);

  update public.wallets
    set balance = balance + v_reward, updated_at = now()
    where user_id = v_uid;

  insert into public.transactions (user_id, type, amount, status, note)
  values (v_uid, 'bonus', v_reward, 'completed',
          v_label || ' Level ' || v_level || ' reward');

  update public.free_game_progress
    set level = level + 1, total_won = total_won + v_reward, updated_at = now()
    where user_id = v_uid and game = p_game;

  return jsonb_build_object('ok', true, 'reward', v_reward,
                            'level_won', v_level, 'next_level', v_level + 1);
end;
$$;

-- Current levels for the signed-in user (defaults to 1 per game).
create or replace function public.my_free_game_progress()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('mines', 1, 'memory', 1, 'flappy', 1);
  end if;
  select jsonb_build_object(
    'mines',  coalesce(max(level) filter (where game = 'mines'), 1),
    'memory', coalesce(max(level) filter (where game = 'memory'), 1),
    'flappy', coalesce(max(level) filter (where game = 'flappy'), 1))
  into v
  from public.free_game_progress
  where user_id = v_uid;
  return coalesce(v, jsonb_build_object('mines', 1, 'memory', 1, 'flappy', 1));
end;
$$;

grant execute on function public.claim_free_game_win(text) to authenticated;
grant execute on function public.my_free_game_progress() to authenticated;
