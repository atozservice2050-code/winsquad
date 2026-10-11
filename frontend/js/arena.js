/* ============================================================
   ARENA — Squad Stakes (public 30-second rounds).
   - get_current_round() -> open round
   - Realtime: round_stats (live totals/countdown), public_rounds
     (round open/closed transitions)
   - place_bid(p_round_id, p_amount, p_is_free)
   - Business rules reflected: top 2 highest bids lose; everyone
     else wins a proportional share. The 10% company fee is NEVER
     shown or mentioned in the UI (admin-side only).
   - Winners list: read from the winners-only `round_results` table
     (round_id, user_id, bid_amount, payout) joined with
     `public_profiles` for display names. Losers are never exposed.
   - Personal result: if the user has a `round_results` row for the
     round they won (payout shown); if they bid but have no row,
     they lost.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, activityLevel, sounds, unlockAudio } from './util.js';

let round = null;            // current open round row
let stats = null;            // live round_stats row for this round
let myBidAmount = null;      // my bid amount this round
let myBidRow = null;         // my bid row (for result detection)
let selectedBid = 10;
let countdownInt = null;
let lastTickSecond = -1;
let resultShownFor = null;   // round id we already popped a result for
let userId = null;
let channels = [];

const STREAK_KEY = () => 'ws_winstreak_' + (userId || 'anon');

export function setUser(id) { userId = id; }

/* ---------------- win streak (personal, device-local) ---------------- */
function getStreak() {
  try { return Number(JSON.parse(localStorage.getItem(STREAK_KEY()) || '0')) || 0; }
  catch { return 0; }
}
function setStreak(n) {
  try { localStorage.setItem(STREAK_KEY(), JSON.stringify(Math.max(0, n))); } catch {}
  renderStreakBars();
}
function renderStreakBars() {
  const n = getStreak();
  const pct = Math.min(n, 10) * 10;
  // Bars rise as the streak builds; on a loss they collapse (reset look).
  $('streak-fill-left').style.height = Math.max(4, pct) + '%';
  $('streak-fill-right').style.height = Math.max(4, pct) + '%';
  $('streak-fill-left').style.opacity = n > 0 ? '1' : '0.35';
  $('streak-fill-right').style.opacity = n > 0 ? '1' : '0.35';
}

/* ---------------- activity signal (Fear & Greed style) ---------------- */
function renderActivity() {
  const level = activityLevel();
  const pill = $('activity-pill');
  pill.className = 'activity ' + level;
  $('activity-label').textContent =
    level === 'peak' ? '🔥 PEAK HOURS' : level === 'down' ? '💤 SLOW HOURS' : '📊 NORMAL HOURS';
  pill.title = level === 'peak'
    ? 'Busiest time (6PM–12AM PKT): biggest pots, most players'
    : level === 'down'
    ? 'Quiet hours (12AM–6AM PKT): smaller pots'
    : 'Normal daytime activity';
}

/* ---------------- round loading ---------------- */
async function loadRound() {
  try {
    const { data, error } = await supabase.rpc('get_current_round');
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || !row.id) { toast('No live round right now — retrying…', true); return; }
    const isNewRound = !round || round.id !== row.id;
    round = row;
    $('round-no').textContent = '#' + (row.round_no ?? '–');
    await loadStats(row.id);
    await loadMyBid(row.id);
    if (isNewRound) {
      resultShownFor = null;
      renderWinnersPlaceholder();
      updateBidEstimates();
    }
    startCountdown();
  } catch (e) {
    console.warn('get_current_round failed', e);
  }
}

async function loadStats(roundId) {
  try {
    const { data } = await supabase.from('round_stats').select('*').eq('round_id', roundId).maybeSingle();
    stats = unwrapRow(data) || stats;
    renderStats();
  } catch (e) { console.warn('round_stats read failed', e); }
}

async function loadMyBid(roundId) {
  try {
    const { data } = await supabase.from('bids').select('*').eq('round_id', roundId)
      .order('created_at', { ascending: false }).limit(1);
    const row = unwrapRow(data);
    myBidRow = row;
    myBidAmount = row ? Number(row.amount) : null;
    $('my-bid').textContent = myBidAmount != null ? 'Rs ' + fmtRs(myBidAmount) : '—';
    updateBidEstimates();
  } catch (e) { console.warn('own bids read failed', e); }
}

/* ---------------- live stats + countdown ---------------- */
function renderStats() {
  const total = Number(stats?.total_bids ?? round?.total_bids ?? 0);
  const players = Number(stats?.player_count ?? round?.player_count ?? 0);
  $('pot-total').textContent = fmtRs(total);
  $('pot-players').textContent = fmtRs(players);
  updateBidEstimates();
}

function startCountdown() {
  clearInterval(countdownInt);
  lastTickSecond = -1;
  countdownInt = setInterval(() => {
    const endsAt = stats?.ends_at || round?.ends_at;
    if (!endsAt) { $('clock-time').textContent = '--:--'; return; }
    const remainMs = new Date(endsAt).getTime() - Date.now();
    const remain = Math.max(0, Math.ceil(remainMs / 1000));
    const mm = String(Math.floor(remain / 60)).padStart(2, '0');
    const ss = String(remain % 60).padStart(2, '0');
    $('clock-time').textContent = mm + ':' + ss;
    $('round-clock').classList.toggle('urgent', remain <= 10 && remain > 0);
    // soft tick in the last 5 seconds
    if (remain <= 5 && remain > 0 && remain !== lastTickSecond) {
      lastTickSecond = remain;
      sounds.tick();
    }
    if (remainMs <= 0) {
      clearInterval(countdownInt);
      setTimeout(loadRound, 1200); // next round should be open
    }
  }, 250);
}

/* ---------------- bid estimates ----------------
   Win rate: the 2 biggest stakes lose, so smaller bids win more
   often. Estimate = base survival rate × size penalty, where the
   penalty shrinks as your stake drops below the average stake.
   Live profit share: your stake as % of the live total — i.e. your
   share of the prize pool, updating live. The company fee is
   backend-side only and never enters these numbers. */
function currentStake() {
  if (selectedBid === 'custom') {
    const v = Number($('custom-bid-input').value);
    return v > 0 ? v : null;
  }
  return selectedBid;
}
function updateBidEstimates() {
  const stake = currentStake();
  const total = Number(stats?.total_bids ?? round?.total_bids ?? 0);
  const players = Number(stats?.player_count ?? round?.player_count ?? 1);

  if (stake && total > 0 && players > 2) {
    const base = (players - 2) / players;                 // survive top-2 rule
    const avg = total / players;
    const penalty = 1 / (1 + stake / Math.max(avg, 1));    // big stake -> lower rate
    const rate = Math.max(1, Math.min(99, base * penalty * 100));
    $('win-rate').textContent = rate.toFixed(0) + '%';
    const share = Math.min(100, (stake / total) * 100);
    $('profit-share').textContent = share.toFixed(1) + '%';
  } else if (stake && total > 0) {
    $('win-rate').textContent = '–%';
    $('profit-share').textContent = Math.min(100, (stake / total) * 100).toFixed(1) + '%';
  } else {
    $('win-rate').textContent = stake ? '–%' : '–%';
    $('profit-share').textContent = '–%';
  }
}

/* ---------------- placing bids ---------------- */
async function placeBid(isFree) {
  unlockAudio();
  if (!round?.id) { toast('Round is loading — wait a second…', true); return; }
  let amount;
  if (isFree) {
    amount = 10;
  } else {
    amount = currentStake();
    if (!amount || amount < 10) { toast('Enter a bid of at least Rs 10.', true); return; }
  }
  const btn = isFree ? $('btn-free-bid') : $('btn-place-bid');
  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('place_bid', {
      p_round_id: round.id, p_amount: amount, p_is_free: isFree,
    });
    if (error) throw error;
    const row = unwrapRow(data);
    if (row && row.ok === false) throw new Error(row.error || 'Bid rejected');
    sounds.click();
    toast(isFree ? '🎁 Free Rs 10 bid placed!' : '⚡ Bid of Rs ' + fmtRs(amount) + ' placed!');
    await loadMyBid(round.id);
    await loadStats(round.id);
  } catch (e) {
    toast(friendlyError(e, 'Bid failed. Try again.'), true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- winners + personal result ---------------- */
function renderWinnersPlaceholder() {
  $('winners-list').innerHTML = '<p class="muted center">Winners appear when the round ends…</p>';
  $('winners-round-label').textContent = '';
}

/** Called when a round settles. Renders top-10 winners and the personal popup. */
async function onRoundSettled(settledRoundId) {
  if (resultShownFor === settledRoundId) return;
  resultShownFor = settledRoundId;
  try {
    // Re-read my bid row — after settlement it should carry the result.
    await loadMyBid(settledRoundId);

    // Winners list: winners-only round_results table + public display names.
    let winners = [];
    try { winners = await loadWinners(settledRoundId); }
    catch (e) { console.warn('round_results read failed', e); }

    renderWinners(winners, settledRoundId);
    await showPersonalResult(settledRoundId);
  } catch (e) { console.warn('settlement render failed', e); }
}

/** Winners-only leaderboard: round_results joined with public display names. */
async function loadWinners(settledRoundId) {
  const { data, error } = await supabase.from('round_results')
    .select('user_id, bid_amount, payout')
    .eq('round_id', settledRoundId)
    .order('payout', { ascending: false })
    .limit(10);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return [];
  const ids = [...new Set(rows.map(r => r.user_id))];
  const names = {};
  try {
    const { data: profs } = await supabase.from('public_profiles')
      .select('id, display_name').in('id', ids);
    (profs || []).forEach(p => { names[p.id] = p.display_name; });
  } catch (e) { console.warn('public_profiles read failed', e); }
  return rows.map(r => ({
    user_id: r.user_id,
    display_name: names[r.user_id] || 'Player',
    name: names[r.user_id] || 'Player',
    bid_amount: Number(r.bid_amount),
    payout_amount: Number(r.payout),
    amount: Number(r.payout),
  }));
}

function renderWinners(winners, settledRoundId) {
  const list = $('winners-list');
  $('winners-round-label').textContent = '· round #' + (round?.round_no ?? '–');
  if (!Array.isArray(winners) || winners.length === 0) {
    list.innerHTML = '<p class="muted center">Results are being calculated…</p>';
    // one retry a few seconds later in case settlement lags
    setTimeout(async () => {
      if (resultShownFor !== settledRoundId) return;
      try {
        const w = await loadWinners(settledRoundId);
        if (w.length) renderWinners(w, settledRoundId);
      } catch {}
    }, 6000);
    return;
  }
  list.innerHTML = '';
  winners.slice(0, 10).forEach((w, i) => {
    const name = w.display_name || w.name || 'Player';
    const amt = w.payout_amount ?? w.amount ?? 0;
    const div = document.createElement('div');
    div.className = 'winner-row';
    div.innerHTML = '<span class="rank">' + (i + 1) + '</span>' +
      '<span class="name"></span><span class="amount">Rs ' + fmtRs(amt) + '</span>';
    div.querySelector('.name').textContent = name;
    list.appendChild(div);
  });
}

/** Personal popup: win -> congratulations + amount; loss -> 😭 sticker.
 *  Determined from the winners-only round_results table: if the user has a
 *  row for this round they won, otherwise (they bid) they lost. */
async function showPersonalResult(settledRoundId) {
  if (!myBidRow) return; // user didn't play this round
  let won = null, payout = 0;
  try {
    const { data, error } = await supabase.from('round_results')
      .select('payout').eq('round_id', settledRoundId).eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    const row = unwrapRow(data);
    if (row) { won = true; payout = Number(row.payout || 0); }
    else { won = false; } // bid exists but no winners row -> lost
  } catch (e) { console.warn('personal result lookup failed', e); return; }

  const modal = $('result-modal');
  const card = modal.querySelector('.result-card');
  if (won === true) {
    setStreak(getStreak() + 1);
    sounds.win();
    $('result-emoji').textContent = '🎉';
    $('result-title').textContent = 'Congratulations!';
    $('result-amount').textContent = 'Rs ' + fmtRs(payout);
    $('result-sub').textContent = 'You won this round! Winnings are in your wallet.';
    card.classList.remove('lost');
  } else if (won === false) {
    setStreak(0);
    sounds.lose();
    $('result-emoji').textContent = '😭';
    $('result-title').textContent = 'Better luck next time';
    $('result-amount').textContent = '';
    $('result-sub').textContent = 'Your bid was among the top 2 highest this round.';
    card.classList.add('lost');
  } else {
    return; // result not determinable — don't pop anything
  }
  modal.hidden = false;
  // Results stay ~10 seconds, then auto-dismiss.
  setTimeout(() => { modal.hidden = true; }, 10000);
}

/* ---------------- realtime ---------------- */
function subscribe() {
  unsubscribe();
  const ch = supabase
    .channel('arena-live')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'round_stats' },
      (payload) => {
        const row = payload.new;
        if (!row || (round && row.round_id !== round.id)) return;
        stats = row;
        renderStats();
      })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'public_rounds' },
      (payload) => {
        const row = payload.new;
        if (!row) return;
        if (row.status === 'closed' && round && row.id === round.id) {
          onRoundSettled(row.id);
          setTimeout(loadRound, 2500); // pick up the next open round
        } else if (row.status === 'open' && (!round || row.id !== round.id)) {
          loadRound();
        }
      })
    .subscribe();
  channels.push(ch);
}
function unsubscribe() {
  channels.forEach(c => { try { supabase.removeChannel(c); } catch {} });
  channels = [];
}

/* ---------------- init ---------------- */
export function initArena() {
  renderActivity();
  renderStreakBars();
  setInterval(renderActivity, 60000); // refresh the signal each minute

  $$('.bid-tab').forEach(tab => tab.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('.bid-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    selectedBid = tab.dataset.amount === 'custom' ? 'custom' : Number(tab.dataset.amount);
    $('custom-bid-row').hidden = selectedBid !== 'custom';
    updateBidEstimates();
  }));
  $('custom-bid-input').addEventListener('input', updateBidEstimates);

  $('btn-place-bid').addEventListener('click', () => placeBid(false));
  $('btn-free-bid').addEventListener('click', () => placeBid(true));
  $('btn-result-close').addEventListener('click', () => { $('result-modal').hidden = true; });
  $('result-modal').addEventListener('click', (e) => {
    if (e.target.id === 'result-modal') $('result-modal').hidden = true;
  });

  loadRound();
  subscribe();
}

export function destroyArena() {
  unsubscribe();
  clearInterval(countdownInt);
}
