/* ============================================================
   REWARDS — referral (Rs 100 joiner, Rs 500 inviter), daily streak claim
   (Rs 10/day increasing to Rs 70 on day 7), free-bid status
   (one Rs 10 public bid per calendar day).
   - claim_daily_streak() -> {ok, streak_day, amount, error}
   - Reads: profiles (referral_id), streaks (own), bids (own free bids)
   - apply_referral(p_referral_id) -> {ok, error}: Rs 100 to both users.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, toast, copyText, unlockAudio, sounds } from './util.js';

let userId = null;
export function setUser(id) { userId = id; }

/* ---------------- referral ---------------- */
export function renderReferral(referralId) {
  $('referral-code').textContent = referralId || 'WS-••••••';
}

async function applyReferral() {
  unlockAudio();
  const code = $('apply-referral-input').value.trim().toUpperCase();
  if (!code) { toast('Enter a referral code.', true); return; }
  $('btn-apply-referral').disabled = true;
  try {
    const { data, error } = await supabase.rpc('apply_referral', { p_referral_id: code });
    if (error) throw error;
    const row = unwrapRow(data);
    if (row && row.ok === false) throw new Error(row.error || 'Code not accepted');
    sounds.win();
    toast('Referral applied — Rs 100 for you, Rs 500 for inviter! 🎉');
    $('apply-referral-input').value = '';
  } catch (e) {
    toast(friendlyError(e, 'That code was not accepted.'), true);
  } finally {
    $('btn-apply-referral').disabled = false;
  }
}

/* ---------------- daily streak ---------------- */
const STREAK_AMOUNTS = [10, 20, 30, 40, 50, 60, 70]; // day 1..7

async function loadStreak() {
  const daysEl = $('streak-days');
  daysEl.innerHTML = '';
  let currentDay = 0;
  let claimedToday = false;
  try {
    const { data } = await supabase.from('streaks').select('*').eq('user_id', userId).maybeSingle();
    const row = unwrapRow(data);
    if (row) {
      currentDay = Number(row.current_day || row.streak_day || 0);
      const last = row.last_claimed_at || row.last_claim_date;
      if (last) {
        const d = new Date(last);
        const now = new Date();
        claimedToday = d.getFullYear() === now.getFullYear() &&
          d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      }
    }
  } catch (e) { console.warn('streaks read failed', e); }

  for (let d = 1; d <= 7; d++) {
    const div = document.createElement('div');
    div.className = 'streak-day' +
      (d <= currentDay && claimedToday ? ' done' : '') +
      (d === currentDay + 1 && !claimedToday ? ' today' : '');
    div.innerHTML = 'Day ' + d + '<span class="d-amt">Rs ' + STREAK_AMOUNTS[d - 1] + '</span>';
    daysEl.appendChild(div);
  }
  const nextDay = Math.min(currentDay + 1, 7);
  const label = $('streak-label');
  if (label) {
    label.textContent = claimedToday
      ? 'Day ' + currentDay + ' · Rs ' + STREAK_AMOUNTS[Math.min(currentDay, 7) - 1] + ' · Claimed ✓'
      : 'Day ' + nextDay + ' · Rs ' + STREAK_AMOUNTS[nextDay - 1] + ' · Ready to claim';
  }
  $('streak-status').textContent = claimedToday
    ? '✅ Claimed for today — come back tomorrow for Day ' + Math.min(nextDay + 1, 7) + '!'
    : 'Next claim: Day ' + nextDay + ' = Rs ' + STREAK_AMOUNTS[nextDay - 1] + '.';
  $('btn-claim-streak').disabled = claimedToday;
  $('btn-claim-streak').textContent = claimedToday ? 'Claimed ✓' : "Claim today's reward";
}

async function claimStreak() {
  unlockAudio();
  $('btn-claim-streak').disabled = true;
  try {
    const { data, error } = await supabase.rpc('claim_daily_streak');
    if (error) throw error;
    const row = unwrapRow(data);
    if (row && row.ok === false) throw new Error(row.error || 'Already claimed');
    sounds.win();
    toast('🔥 Day ' + (row?.streak_day ?? '') + ' claimed: Rs ' + (row?.amount ?? '') + '!');
    await loadStreak();
  } catch (e) {
    toast(friendlyError(e, 'Could not claim. Try again tomorrow.'), true);
    await loadStreak();
  }
}

/* ---------------- free daily bid ---------------- */
async function loadFreeBidStatus() {
  const el = $('free-bid-status');
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const { data, count } = await supabase.from('bids').select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_free', true)
      .gte('created_at', start.toISOString());
    const used = (count ?? (Array.isArray(data) ? data.length : 0)) > 0;
    el.className = 'free-status ' + (used ? 'used' : 'available');
    el.textContent = used
      ? "✅ Today's free bid is used — back tomorrow!"
      : '🎁 Available! Tap the gold button in the Arena.';
  } catch (e) {
    el.className = 'free-status used';
    el.textContent = 'Could not check — try the Arena button.';
  }
}

/* ---------------- init ---------------- */
export function initRewards() {
  $('btn-copy-referral').addEventListener('click', () =>
    copyText($('referral-code').textContent.trim(), 'Referral code copied!'));
  $('btn-apply-referral').addEventListener('click', applyReferral);
  $('btn-claim-streak').addEventListener('click', claimStreak);
  // Mission Vault: open missions view if it exists, else "coming soon"
  $('btn-mission-vault')?.addEventListener('click', () => {
    unlockAudio();
    const mv = $('view-missions');
    if (mv) {
      document.querySelectorAll('.view').forEach(v => { v.hidden = v !== mv; });
      window.scrollTo(0, 0);
    } else {
      toast('Missions coming soon! 🎯');
    }
  });
}

export async function refreshRewards(referralId) {
  renderReferral(referralId);
  await loadStreak();
  await loadFreeBidStatus();
}
