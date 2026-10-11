# WinSquad — Frontend (phone-only static app)

Mobile-first, **phone-only** web app. Pure static files — no build step, no npm.
Deploy the `frontend/` folder directly to **Cloudflare Pages**.

```
frontend/
├── index.html          # all screens (SPA, JS view router)
├── admin.html          # ADMIN PORTAL (owner only — dashboard, users, transactions, rounds, rewards)
├── css/style.css       # green-gold premium casino theme
├── js/
│   ├── env.js          # ← GENERATED at build time (gitignored, never committed)
│   ├── env.example.js  # placeholder template
│   ├── app.js          # boot + view router
│   ├── supabase-client.js  # client singleton + env check
│   ├── util.js         # toast, Web Audio sounds, formatting, PK-time helpers
│   ├── auth.js         # phone → OTP → verify, first-login profile setup
│   ├── arena.js        # Squad Stakes public arena
│   ├── private.js      # private 4-seat tables
│   ├── wallet.js       # balance, deposit/withdraw/transfer, history
│   ├── rewards.js      # referral, daily streak, free-bid status
│   └── profile.js      # IDs, copy buttons, logout
└── .gitignore          # ignores js/env.js
```

**Admin portal** (`admin.html`): owner-only dashboard at `/admin.html`. Requires the
`supabase/migrations/001_admin_policies.sql` migration to be run first (adds admin
RLS policies + withdraw approval RPCs). Sign in with your admin phone number;
`is_admin()` is checked on load and non-admins are denied.

Supabase JS v2 is loaded via CDN ESM import (`cdn.jsdelivr.net/npm/@supabase/supabase-js@2`).

## Screens

1. **Auth** — Pakistani mobile number → 6-digit SMS OTP → verify (Supabase Auth `signInWithOtp` / `verifyOtp`).
2. **Setup** (first login) — display name + optional referral code. Backend trigger creates `referral_id` (`WS-######`) and the 14-digit `transfer_id`.
3. **Arena** (Squad Stakes, default) — 30s countdown (top-right), Fear-&-Greed style activity pill (top-left: 🔥 PEAK 6PM–12AM / 📊 NORMAL / 💤 SLOW, PKT), live pot ticker, bid tabs 10/50/100 + custom, approx win-rate + live profit-share estimates, Place Bid, free Rs 10 bid (1/day), lightning streak bars (rise with personal win streak, reset on loss), Top-10 winners, win/loss popups (Web Audio, no files), results auto-dismiss after ~10s.
4. **Private** — create table (invite code) / join via code, 4 seats, bids 500/800/1000 + custom (min 500), 30s clock starts on first bid, pot total reveals after all 4 bid, only the highest bidder loses.
5. **Wallet** — balance, Deposit (Easypaisa/JazzCash/bank + transaction ID → pending), Withdraw request, Transfer (14-digit transfer ID, max 50% of balance, once/week), transaction history.
6. **Rewards** — referral ID + apply code (Rs 100 both sides), daily streak claim (Rs 10→70 by day 7), free-bid status.
7. **Profile** — name, phone, referral ID, transfer ID (copy buttons), logout.

Phone-only: on screens ≥520px wide the app hides and a "phones only" notice shows instead.

## Backend config — how `js/env.js` is injected on Cloudflare Pages

The app reads `window.__WINSQUAD_ENV__ = { SUPABASE_URL, SUPABASE_ANON_KEY }` from `js/env.js`.
**Never commit real keys** — `js/env.js` is gitignored. If values are missing/placeholder, the app shows a clear "Setup needed" screen.

### Pages setup (recommended)

1. Cloudflare Pages → your project → **Settings → Environment variables** → add:
   - `SUPABASE_URL` = `https://YOUR_PROJECT_REF.supabase.co`
   - `SUPABASE_ANON_KEY` = your Supabase **anon/public** key (never the service-role key)
2. Set the **build command** to generate `js/env.js` before deploy:
   ```bash
   printf 'window.__WINSQUAD_ENV__ = { SUPABASE_URL: "%s", SUPABASE_ANON_KEY: "%s" };\n' \
     "$SUPABASE_URL" "$SUPABASE_ANON_KEY" > js/env.js
   ```
   Build output directory: the `frontend/` folder (or repo root containing it).
3. Local dev: `cp js/env.example.js js/env.js` and fill in the values.

### Realtime prerequisites (Supabase)

Enable Realtime (postgres_changes) for: `round_stats`, `public_rounds`, `private_tables`, `private_seats`, `private_bids`. The frontend subscribes to these and re-renders on INSERT/UPDATE.

## Backend contract used (must match `supabase/schema.sql`)

RPCs: `get_current_round()`, `place_bid(p_round_id, p_amount, p_is_free)`,
`transfer_funds(p_to_transfer_id, p_amount)`, `claim_daily_streak()`,
`create_private_table()`, `join_private_table(p_code)`, `place_private_bid(p_table_id, p_amount)`.

Reads: `public_rounds` (client-safe, no fee), `round_stats`, `bids` (own), `wallets` (own),
`transactions` (own), `rewards` (own), `streaks` (own), `profiles` (own), `public_profiles`,
`private_tables` / `private_seats` / `private_bids` (tables the user sits at).

The 10% company fee is **never displayed** anywhere in the UI (admin-side only).

## Gaps / assumptions (flagged for the backend author)

1. **Winners list**: arena reads a client-safe `winners` (or `top_winners`/`top10`) JSON array
   `[{display_name|name, payout_amount|amount, user_id?}]` from the settled `public_rounds` row.
   If the schema exposes winners differently, point `arena.js → renderWinners()` at it.
2. **Personal result**: after settlement the user's own `bids` row is re-read; the code prefers
   `is_winner` / `payout_amount` columns on that row, and falls back to matching `user_id`
   inside the winners array. If neither exists, no popup is shown (nothing is guessed).
3. **Deposit/withdraw**: submitted as inserts into `deposit_requests` / `withdraw_requests`
   with `status='pending'`. If those tables don't exist the insert fails safely with a
   "contact support" message — confirm table names with the backend author.
4. **`apply_referral` RPC** is not in the frontend contract — the UI attempts it defensively
   (setup + rewards screens) and toasts a friendly message if unavailable. If the backend
   handles referrals differently (e.g. trigger on `profiles.referred_by`), wire it there.
5. **Private table columns** (`current_ends_at`, `status`, seat `display_name`, per-round
   `private_bids`) are best-effort guesses; every read is null-safe and the UI degrades
   gracefully ("Waiting for first bid…").
6. **Win streak bars** are device-local (localStorage per user) — a backend `win_streak`
   column would make them cross-device.
7. **Free-bid status** checks the user's `bids` for `is_free = true` created today (PKT
   midnight via local date). `place_bid(..., p_is_free=true)` is the source of truth.
