-- ============================================================================
-- 037 — Player promo push schedule (owner order 2026-11-21).
-- Sends the 3 real-message promo notifications/day to ALL players via the
-- push-player-promo Edge Function, and reserves the extra ad batch.
--
-- REAL BATCH (live once this file runs): 3 sends/day, evening PKT:
--   18:00 PKT  slot daily   (daily reward reminder)
--   20:00 PKT  slot peak    (peak-hours squad promo)
--   22:00 PKT  slot table   (private-table promo)
-- PKT = UTC+5, no DST, so the cron times below are UTC:
--   18:00 PKT = 13:00 UTC, 20:00 PKT = 15:00 UTC, 22:00 PKT = 17:00 UTC.
--
-- EXTRA AD BATCH (NOT decided yet): the owner will pick 5, 7 or 10 extra
-- sends/day at daytime slots. The three ready-made blocks are at the
-- bottom of this file, all commented out — uncomment exactly ONE once
-- the owner picks the count. Each ad send posts {"slot": "ad"} and the
-- function rotates the three real message texts by hour. The extra batch
-- adds on top of the 3 evening sends (totals: 8, 10 or 13/day).
--
-- PREREQUISITES (do these first, in order):
--   1. Deploy supabase/functions/push-player-promo (see its DEPLOY.md).
--   2. Set the Edge Function secret PROMO_HOOK_SECRET (Dashboard >
--      Edge Functions > push-player-promo > Secrets, or
--      `supabase secrets set PROMO_HOOK_SECRET='<random>'`).
--   3. Database > Extensions: enable pg_cron AND pg_net.
--   4. Store the two call secrets in Vault — replace the placeholders
--      with the REAL values (anon key: Project Settings > API).
--        select vault.create_secret('<PROMO_HOOK_SECRET>', 'winsquad_promo_hook_secret');
--        select vault.create_secret('<ANON_KEY>', 'winsquad_anon_key');
--   5. Run THIS file in the SQL Editor.
--
-- How a send works: pg_cron fires net.http_post to the Edge Function
-- URL with the anon key (Edge Function JWT check) + x-hook-secret.
-- pg_net is async: the request id returns immediately; delivery status
-- can be checked in net._http_response. If a send ever times out,
-- raise timeout_milliseconds (currently 30000).
-- ============================================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- --- REAL BATCH: 3 evening sends (PKT) ------------------------------------
-- 18:00 PKT (13:00 UTC) — daily reward reminder
select cron.schedule(
  'winsquad-promo-daily',
  '0 13 * * *',
  $$
  select net.http_post(
    'https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
    '{"slot": "daily"}'::jsonb,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
      'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')
    ),
    30000
  );
  $$
);

-- 20:00 PKT (15:00 UTC) — peak-hours squad promo
select cron.schedule(
  'winsquad-promo-peak',
  '0 15 * * *',
  $$
  select net.http_post(
    'https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
    '{"slot": "peak"}'::jsonb,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
      'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')
    ),
    30000
  );
  $$
);

-- 22:00 PKT (17:00 UTC) — private-table promo
select cron.schedule(
  'winsquad-promo-table',
  '0 17 * * *',
  $$
  select net.http_post(
    'https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
    '{"slot": "table"}'::jsonb,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
      'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')
    ),
    30000
  );
  $$
);

-- --- VERIFY (run after this file) -----------------------------------------
-- select jobname, schedule, active from cron.job
--  where jobname like 'winsquad-promo%' order by jobname;
-- Delivery check after a send fires:
-- select * from net._http_response order by created desc limit 5;

-- --- REMOVE (if ever needed) ----------------------------------------------
-- select cron.unschedule('winsquad-promo-daily');
-- select cron.unschedule('winsquad-promo-peak');
-- select cron.unschedule('winsquad-promo-table');

-- ============================================================================
-- EXTRA AD BATCH — PARAMETER: EXTRA_AD_COUNT (owner picks 5, 7 or 10).
-- NOT chosen yet. Uncomment exactly ONE of the three blocks below once the
-- owner picks the count, then run the uncommented block in SQL Editor.
-- Each job posts {"slot": "ad"}; the function rotates the three real
-- message texts by hour. Daytime slots only (PKT -> UTC shown).
-- Totals with the 3 evening sends: 5 -> 8/day, 7 -> 10/day, 10 -> 13/day.
-- ============================================================================

-- --- OPTION A: 5 extra ad sends/day ---------------------------------------
-- -- 10:00 PKT (05:00 UTC)
-- select cron.schedule('winsquad-promo-ad-01', '0 5 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 11:30 PKT (06:30 UTC)
-- select cron.schedule('winsquad-promo-ad-02', '30 6 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 13:00 PKT (08:00 UTC)
-- select cron.schedule('winsquad-promo-ad-03', '0 8 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 14:30 PKT (09:30 UTC)
-- select cron.schedule('winsquad-promo-ad-04', '30 9 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 16:00 PKT (11:00 UTC)
-- select cron.schedule('winsquad-promo-ad-05', '0 11 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);

-- --- OPTION B: 7 extra ad sends/day ---------------------------------------
-- -- 10:00 PKT (05:00 UTC)
-- select cron.schedule('winsquad-promo-ad-01', '0 5 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 11:00 PKT (06:00 UTC)
-- select cron.schedule('winsquad-promo-ad-02', '0 6 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 12:30 PKT (07:30 UTC)
-- select cron.schedule('winsquad-promo-ad-03', '30 7 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 14:00 PKT (09:00 UTC)
-- select cron.schedule('winsquad-promo-ad-04', '0 9 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 15:00 PKT (10:00 UTC)
-- select cron.schedule('winsquad-promo-ad-05', '0 10 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 16:00 PKT (11:00 UTC)
-- select cron.schedule('winsquad-promo-ad-06', '0 11 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 17:00 PKT (12:00 UTC)
-- select cron.schedule('winsquad-promo-ad-07', '0 12 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);

-- --- OPTION C: 10 extra ad sends/day --------------------------------------
-- -- 10:00 PKT (05:00 UTC)
-- select cron.schedule('winsquad-promo-ad-01', '0 5 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 10:45 PKT (05:45 UTC)
-- select cron.schedule('winsquad-promo-ad-02', '45 5 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 11:30 PKT (06:30 UTC)
-- select cron.schedule('winsquad-promo-ad-03', '30 6 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 12:15 PKT (07:15 UTC)
-- select cron.schedule('winsquad-promo-ad-04', '15 7 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 13:00 PKT (08:00 UTC)
-- select cron.schedule('winsquad-promo-ad-05', '0 8 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 13:45 PKT (08:45 UTC)
-- select cron.schedule('winsquad-promo-ad-06', '45 8 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 14:30 PKT (09:30 UTC)
-- select cron.schedule('winsquad-promo-ad-07', '30 9 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 15:15 PKT (10:15 UTC)
-- select cron.schedule('winsquad-promo-ad-08', '15 10 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 16:00 PKT (11:00 UTC)
-- select cron.schedule('winsquad-promo-ad-09', '0 11 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
-- -- 16:45 PKT (11:45 UTC)
-- select cron.schedule('winsquad-promo-ad-10', '45 11 * * *', $$
--   select net.http_post('https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo',
--     '{"slot": "ad"}'::jsonb,
--     jsonb_build_object('Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_anon_key'),
--       'x-hook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'winsquad_promo_hook_secret')), 30000);
-- $$);
