# push-player-promo — deploy + test

Function: `supabase/functions/push-player-promo/index.ts`
Project ref: `kzjkvhtakwohxxuysuto`
URL (after deploy): `https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo`

## 1. Deploy

Supabase CLI (logged in):

```bash
supabase functions deploy push-player-promo --project-ref kzjkvhtakwohxxuysuto
```

Or Dashboard > Edge Functions > Deploy a new function > paste `index.ts`
(name: `push-player-promo`). Leave "Verify JWT" **ON** (default) — the
cron jobs pass the anon key as the Bearer token.

## 2. Secret

Set the hook secret (the SAME value goes into Vault for the cron jobs):

```bash
supabase secrets set PROMO_HOOK_SECRET='<random-string>' --project-ref kzjkvhtakwohxxuysuto
```

Or Dashboard > Edge Functions > push-player-promo > Secrets.

## 3. Schedule

Run `supabase/migrations/037_push_player_promo_schedule.sql` in the SQL
Editor, after the Vault prerequisites in its header (pg_cron + pg_net
enabled, vault secrets `winsquad_promo_hook_secret` and
`winsquad_anon_key` created).

## 4. Dry-run test (safe — sends nothing)

```bash
curl -X POST https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "x-hook-secret: <PROMO_HOOK_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"dry_run": true, "slot": "daily"}'
```

Expected response:

```json
{"ok":true,"dry_run":true,"slot":"daily","resolved_text":"daily","title":"WinSquad","body":"Your daily reward is ready — open WinSquad and claim it!","open_url":"https://uplcm.com/4/12313060","tokens":N,"would_send":N}
```

`N` is the registered player-device count. Run this before any real send.

## 5. One-token live test (optional)

Send only to one device (the owner's) to prove a real notification
arrives and the tap opens the ad in Chrome:

```bash
curl -X POST https://kzjkvhtakwohxxuysuto.supabase.co/functions/v1/push-player-promo \
  -H "Authorization: Bearer <ANON_KEY>" \
  -H "x-hook-secret: <PROMO_HOOK_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"slot": "daily", "test_token": "<FCM token of the test device>"}'
```

Get the test device's token from:

```sql
select token from public.user_push_tokens where user_id = '<owner uuid>';
```

(owner = Yahya.) Never call the function with a real slot and no
`test_token` until the dry-run count looks right.

## 6. Verify the schedule

```sql
select jobname, schedule, active from cron.job
 where jobname like 'winsquad-promo%' order by jobname;
```

Check a send actually fired (pg_net responses):

```sql
select * from net._http_response order by created desc limit 5;
```

## Notes

- The daily text is the real daily streak: the app has a claimable
  daily streak (Rs 10 day 1, +Rs 10/day to Rs 70 day 7,
  `claim_daily_streak()` RPC in `frontend/js/rewards.js`) — no
  rewording was needed.
- Failed sends are reported by reason (e.g. `UNREGISTERED` for
  uninstalled apps). Invalid tokens are NOT deleted automatically.
- Extra ad batch (5 / 7 / 10 per day): NOT chosen yet — see the
  commented blocks at the bottom of migration 037; uncomment exactly
  one block once the owner picks the count.
- `push-on-presence` (admin alerts) was not touched.
