# WinSquad — Production App

**"Play together. Win together."** — a mobile-first, phone-only real-money gaming app.

This is the production codebase (not a demo). Everything persists in the backend.

## Stack (all free)

| Layer      | Service                                     |
|------------|---------------------------------------------|
| Backend    | **Supabase** — Postgres + Auth (phone OTP) + Realtime |
| Frontend   | Static site → **Cloudflare Pages** (free)   |
| Code       | **GitHub**                                  |

## Project structure

```
winsquad-app/
├── supabase/
│   └── schema.sql        # Full backend: 13 tables, RLS, game-engine
│                         # functions, realtime, triggers. Run once.
├── frontend/
│   ├── index.html        # All screens (SPA)
│   ├── css/style.css     # Green-gold premium casino theme
│   └── js/               # App modules (Supabase JS v2 via CDN, no build step)
│       ├── env.example.js
│       └── env.js        # GENERATED from env vars — gitignored, never commit
└── README.md
```

## Setup

### 1. Supabase project (free)

1. Create a project at [supabase.com](https://supabase.com) (free tier).
2. Open **SQL Editor** and run the entire `supabase/schema.sql` top-to-bottom.
3. Post-run checklist (also at the bottom of `schema.sql`):
   - **Enable pg_cron**: Database → Extensions → turn on `pg_cron`, then run:
     ```sql
     select cron.schedule('winsquad-resolve-rounds', '* * * * *',
                          $$select public.resolve_due_rounds()$$);
     ```
     (Minute granularity → round resolution may lag up to ~60s; `get_current_round()` / `place_bid()` also resolve opportunistically so gameplay never stalls.)
   - **Make yourself admin** after your first phone-OTP sign-in (find your UUID in Authentication → Users):
     ```sql
     insert into public.admins (user_id) values ('PASTE-YOUR-UUID-HERE');
     ```
   - **Phone OTP**: Authentication → Providers → enable Phone, add an SMS provider (Supabase/Twilio). Test numbers work without SMS on the free tier.

### 2. Frontend env vars (no hardcoded secrets)

```bash
cd frontend
cp js/env.example.js js/env.js
# edit js/env.js with your project's values:
#   SUPABASE_URL=https://xyzcompany.supabase.co
#   SUPABASE_ANON_KEY=eyJhbGciOi...
```

Get both from Supabase → Project Settings → API. The app shows a clear
"Setup needed" screen if `js/env.js` is missing. `js/env.js` is gitignored.

### 3. Deploy to Cloudflare Pages (free)

1. Push this repo to GitHub (see below).
2. Cloudflare Dashboard → Pages → **Create** → connect the GitHub repo.
3. Build settings: **no build command**, output directory `frontend`.
4. Environment variables → add `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
5. Add a build command that generates `js/env.js` from the env vars, e.g.:
   ```bash
   printf 'window.__WINSQUAD_ENV__={SUPABASE_URL:"%s",SUPABASE_ANON_KEY:"%s"};' \
     "$SUPABASE_URL" "$SUPABASE_ANON_KEY" > frontend/js/env.js
   ```
6. Deploy. Every `git push` redeploys automatically.

### 4. GitHub

```bash
cd winsquad-app
git init
git add .
git commit -m "WinSquad production app: Supabase backend + mobile frontend"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/winsquad-app.git
git push -u origin main
```

## Game rules (encoded in the backend)

- **Squad Stakes**: 30-second rounds, bids 10/50/100 + custom. Top 2 highest bids
  lose (tie → earliest bid loses); everyone else splits **90%** of the losers'
  pool proportionally. **10% company fee is recorded but NEVER shown to users.**
- **Private tables**: invite code, 4 seats, min bid 500 (500/800/1000+custom).
  Only the single highest bidder loses. Clock starts on first bid (30s);
  table total reveals after all 4 bid.
- **Rewards**: referral = Rs 100 to **both** users; daily streak Rs 10,
  +Rs 10/day up to day 7; **one free Rs 10 bid per calendar day** (server-enforced, Asia/Karachi).
- **Transfers**: to another user's 14-digit transfer ID, max 50% of balance,
  once per 7 days (server-enforced).
- **Deposits/withdrawals**: manual — user submits Easypaisa/JazzCash/bank
  transaction ID (status `pending`); admin approves via `approve_deposit()`.
  No payment APIs are integrated (by design).
- **Bots vs real players**: display counts are cosmetic; payouts always compute
  from actual bid rows only.

## Security notes

- Row Level Security on every table; clients can never read `rounds.fee_amount`
  (use the `public_rounds` view), other users' bids, or other users' wallets.
- All money movement goes through `SECURITY DEFINER` RPC functions with
  server-side validation. Direct table writes are locked down.
- Never commit `frontend/js/env.js` (anon key is public by design, but keep it
  out of the repo anyway).
