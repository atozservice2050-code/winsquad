/* ============================================================
   ARENA — Squad Stakes (public 30-second rounds). SIMPLIFIED UI.
   - get_current_round() -> open round
   - Realtime: round_stats (live totals/countdown), public_rounds
     (round open/closed transitions)
   - place_bid(p_round_id, p_amount, p_is_free)
   - Business rules: top 2 highest bids lose; everyone else wins a
     proportional share. The 10% company fee is NEVER shown or
     mentioned in the UI (admin-side only).
   - Winners list: read from the winners-only `round_results` table
     joined with `public_profiles` for display names. Losers never
     exposed.
   - Personal result: if the user has a `round_results` row for the
     round they won (payout shown); if they bid but have no row,
     they lost.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, activityLevel, sounds, unlockAudio, isSoundOn, setSoundOn } from './util.js';
import { addNotification } from './notifications.js';
import { refreshWallet } from './wallet.js';
import { recordMissionEvent } from './missions.js';

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

export function setUser(id) { userId = id; }

/* ---------------- activity signal (Fear & Greed style) ---------------- */
function renderActivity() {
  const level = activityLevel();
  const pill = $('activity-pill');
  if (!pill) return;
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
      wheelSpinUp(); // new round -> wheel spins up again
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
    // Update bots based on real player count
    const playerCount = Number(stats?.player_count || 0);
    if (playerCount !== realPlayerCount) {
      updateRealPlayerCount(playerCount);
    }
  } catch (e) { console.warn('round_stats read failed', e); }
}

async function loadMyBid(roundId) {
  try {
    const { data } = await supabase.from('bids').select('*')
      .eq('round_id', roundId).eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(1);
    const row = unwrapRow(data);
    myBidRow = row;
    myBidAmount = row ? Number(row.amount) : null;
    const myBidEl = $('my-bid');
    const myBidRowEl = $('my-bid-row');
    if (myBidEl) myBidEl.textContent = myBidAmount != null ? 'Rs ' + fmtRs(myBidAmount) : '—';
    if (myBidRowEl) myBidRowEl.hidden = myBidAmount == null;
  } catch (e) { console.warn('own bids read failed', e); }
}

/* ---------------- live stats + countdown ---------------- */
function updateRealPlayerCount(count) {
  realPlayerCount = count || 0;
  simulateBotBids(); // re-generate bots based on new count
  renderPlayers();
}

function renderStats() {
  const realPlayers = Number(stats?.player_count ?? round?.player_count ?? 0);
  // Show bots in the live count to look lively (visual only)
  const displayPlayers = realPlayers + botBids.length;
  const potPlayers = $('pot-players');
  if (potPlayers) potPlayers.textContent = fmtRs(displayPlayers);
  // hidden compat spans
  const potTotal = $('pot-total');
  if (potTotal) potTotal.textContent = fmtRs(Number(stats?.total_bids ?? round?.total_bids ?? 0));
  const realCount = $('real-players-count');
  if (realCount) realCount.textContent = realPlayers;
  renderPlayers();
}

/* ---------------- players (simple horizontal scroll) ----------------
   BOT SIMULATION (display-only): Bots make the game look lively.
   CRITICAL: Bots NEVER touch the database or payout logic.
   Real bids/payouts use ONLY actual user data via Supabase. */
const SEAT_EMOJIS = ['🦁', '🐯', '🦊', '🐼', '🐨', '🦄', '🐸', '🐵'];
const SEAT_NAMES = ['Ali', 'Sara', 'Usman', 'Fatima', 'Bilal', 'Ayesha', 'Omar', 'Zara', 'Hassan', 'Maryam'];
let chartTimer = null;
let botBids = []; // visual-only, never sent to backend
let realPlayerCount = 0; // track real players in current round

// POOL OF 100 BOTS with Pakistani names
const BOT_POOL = [
  'Ali', 'Ahmed', 'Sara', 'Fatima', 'Usman', 'Ayesha', 'Bilal', 'Zara', 'Omar', 'Maryam',
  'Hassan', 'Sana', 'Imran', 'Nadia', 'Faisal', 'Rabia', 'Kamran', 'Sadia', 'Tariq', 'Asma',
  'Junaid', 'Hina', 'Waqas', 'Farah', 'Adnan', 'Shazia', 'Rizwan', 'Mehwish', 'Salman', 'Amina',
  'Danish', 'Kiran', 'Fahad', 'Samina', 'Arslan', 'Tania', 'Shahid', 'Rukhsana', 'Noman', 'Shabana',
  'Yasir', 'Nasreen', 'Hamza', 'Uzma', 'Sajid', 'Parveen', 'Asif', 'Noreen', 'Kashif', 'Shaista',
  'Irfan', 'Bushra', 'Tahir', 'Saba', 'Javed', 'Anum', 'Rashid', 'Hafsa', 'Azhar', 'Iqra',
  'Mudassir', 'Laiba', 'Shafiq', 'Mahnoor', 'Naveed', 'Areeba', 'Pervez', 'Dania', 'Sohail', 'Eman',
  'Akram', 'Fiza', 'Zahid', 'Alina', 'Mansoor', 'Hira', 'Rafiq', 'Sanaullah', 'Taimoor', 'Kinza',
  'Shahzad', 'Madiha', 'Waseem', 'Sidra', 'Farhan', 'Areej', 'Nadeem', 'Zunaira', 'Khalid', 'Maheen',
  'Saqib', 'Iram', 'Jibran', 'Sehrish', 'Umair', 'Tooba', 'Fawad', 'Aiman', 'Haris', 'Minahil',
].map((name, i) => ({
  name: name,
  emoji: ['😎','🤠','🧑‍💼','👩‍💼','🧔','👱‍♀️','👨‍🦰','👩','🧑','👴','👵','🤴','👸','👷','🕵️'][i % 15],
  baseBid: 10 + Math.floor(Math.random() * 491), // 10-500 fixed per bot
}));

function simulateBotBids() {
  // Select up to 10 bots from the 100-bot pool
  // If real player bid, only bots with LOWER bids than player
  const playerBid = myBidRow ? Number(myBidRow.amount || 0) : 0;
  const targetBots = Math.max(0, 10 - realPlayerCount);

  // Filter pool: bots with bid < playerBid (or all if no player bid)
  let eligible = BOT_POOL;
  if (playerBid > 10) {
    eligible = BOT_POOL.filter(b => b.baseBid < playerBid);
  }
  // If not enough eligible, use all
  if (eligible.length < targetBots) eligible = BOT_POOL;

  // Randomly pick (shuffled)
  const shuffled = [...eligible].sort(() => Math.random() - 0.5);
  botBids = shuffled.slice(0, targetBots).map(b => ({
    emoji: b.emoji,
    name: b.name,
    amount: b.baseBid,
  }));
}

function renderPlayers() {
  const row = $('players-row');
  if (!row) return;
  row.innerHTML = '';
  // Chip 1: you (if you bid this round) — REAL user
  if (myBidRow) {
    const chip = document.createElement('div');
    chip.className = 'player-chip you';
    chip.innerHTML = '<span class="chip-emoji">😎</span><span class="chip-name">You</span><span class="chip-bid">Rs ' + fmtRs(Number(myBidRow.amount || 0)) + '</span>';
    row.appendChild(chip);
  }
  // Bot chips (visual only)
  botBids.forEach(b => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    chip.innerHTML = '<span class="chip-emoji"></span><span class="chip-name"></span><span class="chip-bid">Rs ' + fmtRs(b.amount) + '</span>';
    chip.querySelector('.chip-emoji').textContent = b.emoji;
    chip.querySelector('.chip-name').textContent = b.name;
    row.appendChild(chip);
  });
  // If nobody yet, show a friendly placeholder
  if (row.children.length === 0) {
    row.innerHTML = '<p class="muted center" style="width:100%">Players will appear here…</p>';
  }
}

function startChartLive() {
  clearInterval(chartTimer);
  simulateBotBids(); // initial bots
  renderPlayers();
  chartTimer = setInterval(() => {
    simulateBotBids(); // refresh bots every cycle
    renderPlayers();
  }, 5000);
}

/* Fallback: poll for round settlement (if realtime fails in WebView) */
let settlePollTimer = null;
let lastBidRoundId = null; // track which round the user bid in
function startSettlePoll() {
  clearInterval(settlePollTimer);
  settlePollTimer = setInterval(async () => {
    const checkId = lastBidRoundId || (round && round.id);
    if (!checkId || resultShownFor === checkId) return;
    try {
      const { data } = await supabase.from('public_rounds')
        .select('id, status')
        .eq('id', checkId)
        .maybeSingle();
      if (data && data.status === 'closed') {
        onRoundSettled(checkId);
      }
    } catch (e) { /* silent */ }
  }, 3000);
}
function stopSettlePoll() {
  clearInterval(settlePollTimer);
}

/* Check minimum 3 players at 5-sec mark — show ERROR only to bidders */
async function checkMinPlayers() {
  if (!round?.id) return;
  // Only show to users who placed a bid
  if (!myBidRow) return;
  try {
    const { count } = await supabase.from('bids')
      .select('id', { count: 'exact', head: true })
      .eq('round_id', round.id);
    if (count !== null && count < 3) {
      // Show internal error only to bidders (not everyone)
      const modal = $('result-modal');
      const card = modal.querySelector('.result-card');
      sounds.lose();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      $('result-emoji').textContent = '⚠️';
      $('result-title').textContent = 'Internal Error';
      $('result-amount').textContent = '';
      $('result-sub').textContent = 'Not enough players. Your bid will be refunded.';
      card.classList.add('lost');
      modal.hidden = false;
    }
  } catch (e) { /* silent */ }
}

function startCountdown() {
  clearInterval(countdownInt);
  lastTickSecond = -1;
  countdownInt = setInterval(() => {
    const endsAt = stats?.ends_at || round?.ends_at;
    const clockEl = $('clock-time');
    const clockWrap = $('round-clock');
    if (!endsAt) { if (clockEl) clockEl.textContent = '--:--'; return; }
    const remainMs = new Date(endsAt).getTime() - Date.now();
    const remain = Math.max(0, Math.ceil(remainMs / 1000));
    const mm = String(Math.floor(remain / 60)).padStart(2, '0');
    const ss = String(remain % 60).padStart(2, '0');
    if (clockEl) clockEl.textContent = mm + ':' + ss;
    if (clockWrap) clockWrap.classList.toggle('urgent', remain <= 10 && remain > 0);
    wheelOnTick(remainMs); // roulette wheel: slow down in last 3s, land at 0
    // soft tick in the last 5 seconds
    if (remain <= 5 && remain > 0 && remain !== lastTickSecond) {
      lastTickSecond = remain;
      sounds.tick();
      // 5-sec warning: check if fewer than 3 real bidders
      if (remain === 5) {
        checkMinPlayers();
      }
    }
    if (remainMs <= 0) {
      clearInterval(countdownInt);
      setTimeout(loadRound, 1200); // next round should be open
    }
  }, 250);
}

/* ============================================================
   ROULETTE WHEEL (VISUAL ONLY — synced to the 30s round timer)
   The wheel + ball are a real-looking visual layer. They do NOT
   affect Squad Stakes bidding, settlement or payouts in any way.

   HOUSE CONTROL: where the ball lands is NOT truly random by
   default. `setRouletteResult(number)` lets backend/game logic
   dictate the landing pocket for the NEXT round end. If no result
   is set, a random pocket is picked (one-shot: the forced value
   is consumed after each landing).
   ============================================================ */
// American wheel order (clockwise from 0), 38 pockets: 0, 00, 1-36
const WHEEL_ORDER = ['0','28','9','26','30','11','7','20','32','17','5','22','34','15','3','24','36','13','1','00','27','10','25','29','12','8','19','31','18','6','21','33','16','4','23','35','14','2'];
const WHEEL_RED = new Set(['1','3','5','7','9','12','14','16','18','19','21','23','25','27','30','32','34','36']);
const WHEEL_STEP = 360 / WHEEL_ORDER.length;
const POCKET_INDEX = {};
WHEEL_ORDER.forEach((n, i) => { POCKET_INDEX[n] = i; });
function pocketColor(n) { return n === '0' || n === '00' ? 'green' : (WHEEL_RED.has(n) ? 'red' : 'black'); }

const ROTOR_SPEED = 200;   // deg/sec, clockwise
const BALL_SPEED = -780;   // deg/sec, counter-clockwise (opposite the wheel)
const SLOW_MS = 3000;      // deceleration window before round end
const LAND_MS = 1000;      // ball settle animation

let wsRotor = null, wsOrbit = null, wsWheel = null, wsResultEl = null, wsResultNum = null;
let wheelState = 'idle';   // idle | spin | slow | landing | stopped
let rotorAngle = 0, ballAngle = 0;
let wheelEndsAt = 0;
let wheelRaf = null, wheelLastT = 0;
let landFrom = 0, landDelta = 0, landStart = 0, landNumber = null;
let forcedRouletteNumber = null; // house-controlled landing pocket (one-shot)
let wheelBuilt = false;

function mod360(a) { return ((a % 360) + 360) % 360; }
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

/**
 * HOUSE CONTROL API — call before the round ends to dictate where the
 * ball lands. Accepts 0-36 (number) or '00'. Example:
 *   setRouletteResult(7);   // ball will land on 7
 *   setRouletteResult('00');// ball will land on 00
 * One-shot: consumed at the next landing, then resets to random.
 */
export function setRouletteResult(number) {
  const key = String(number);
  forcedRouletteNumber = (key in POCKET_INDEX) ? key : null;
  return forcedRouletteNumber;
}

function buildWheelPockets() {
  if (wheelBuilt) return;
  wsRotor = $('ws-rotor'); wsOrbit = $('ws-ball-orbit');
  wsWheel = $('ws-wheel'); wsResultEl = $('ws-result'); wsResultNum = $('ws-result-num');
  if (!wsRotor) return; // wheel HTML not present
  const R = 76, C = 86; // radius + center of the 172px pockets ring
  WHEEL_ORDER.forEach((n, i) => {
    const a = (i * WHEEL_STEP) * Math.PI / 180;
    const d = document.createElement('div');
    d.className = 'roulette-pocket ' + pocketColor(n);
    d.textContent = n;
    d.style.left = (C + R * Math.sin(a)).toFixed(1) + 'px';
    d.style.top = (C - R * Math.cos(a)).toFixed(1) + 'px';
    wsRotor.appendChild(d);
  });
  wheelBuilt = true;
}

function pickLandingNumber() {
  const forced = forcedRouletteNumber;
  forcedRouletteNumber = null; // one-shot: consumed
  if (forced && forced in POCKET_INDEX) return forced;
  return WHEEL_ORDER[Math.floor(Math.random() * WHEEL_ORDER.length)];
}

function wheelSpinUp() {
  if (!wheelBuilt) return;
  wheelState = 'spin';
  rotorAngle = mod360(rotorAngle);
  ballAngle = mod360(ballAngle);
  landNumber = null;
  if (wsResultEl) wsResultEl.hidden = true;
  if (wsWheel) wsWheel.classList.remove('landed');
}

/** Called every countdown tick with ms remaining in the round. */
function wheelOnTick(remainMs) {
  if (!wheelBuilt) return;
  if (wheelState === 'spin' && remainMs <= SLOW_MS && remainMs > 0) {
    wheelEndsAt = Date.now() + remainMs;
    wheelState = 'slow';
  } else if ((wheelState === 'slow' || wheelState === 'spin') && remainMs <= 0) {
    wheelLand();
  }
}

function wheelLand() {
  if (!wheelBuilt || wheelState === 'landing' || wheelState === 'stopped') return;
  wheelState = 'landing';
  const num = pickLandingNumber();
  landNumber = num;
  const target = mod360(POCKET_INDEX[num] * WHEEL_STEP + rotorAngle);
  const cur = mod360(ballAngle);
  landFrom = cur;
  landDelta = mod360(target - cur) + 360; // shortest path + one final sweep
  landStart = performance.now();
}

function wheelShowResult(num) {
  if (wsResultNum) {
    wsResultNum.textContent = num;
    wsResultNum.className = 'ws-result-num ' + pocketColor(num);
  }
  if (wsResultEl) wsResultEl.hidden = false;
  if (wsWheel) wsWheel.classList.add('landed');
}

function wheelFrame(now) {
  wheelRaf = requestAnimationFrame(wheelFrame);
  const dt = Math.min(0.05, Math.max(0, (now - wheelLastT) / 1000));
  wheelLastT = now;
  if (wheelState === 'spin') {
    rotorAngle = mod360(rotorAngle + ROTOR_SPEED * dt);
    ballAngle = mod360(ballAngle + BALL_SPEED * dt);
  } else if (wheelState === 'slow') {
    const remainMs = Math.max(0, wheelEndsAt - Date.now());
    const k = easeOutCubic(remainMs / SLOW_MS);
    rotorAngle = mod360(rotorAngle + ROTOR_SPEED * k * dt);
    ballAngle = mod360(ballAngle + BALL_SPEED * k * dt);
    if (remainMs <= 0) wheelLand();
  } else if (wheelState === 'landing') {
    const t = Math.min(1, (now - landStart) / LAND_MS);
    ballAngle = landFrom + landDelta * easeOutCubic(t);
    if (t >= 1) {
      wheelState = 'stopped';
      wheelShowResult(landNumber);
    }
  }
  if (wsRotor) wsRotor.style.transform = 'rotate(' + rotorAngle + 'deg)';
  if (wsOrbit) wsOrbit.style.transform = 'rotate(' + ballAngle + 'deg)';
}

function startWheelLoop() {
  buildWheelPockets();
  if (wheelRaf || !wheelBuilt) return;
  wheelLastT = performance.now();
  wheelRaf = requestAnimationFrame(wheelFrame);
}

function stopWheelLoop() {
  if (wheelRaf) cancelAnimationFrame(wheelRaf);
  wheelRaf = null;
  wheelState = 'idle';
}

/* ---------------- bid amount tabs ---------------- */
function currentStake() {
  if (selectedBid === 'custom') {
    const v = Number($('custom-bid-input').value);
    return v > 0 ? v : null;
  }
  return selectedBid;
}

/* ---------------- placing bids ---------------- */
async function placeBid(isFree) {
  unlockAudio();
  if (!round?.id) { toast('Round is loading — wait a second…', true); return; }
  // Don't allow bids when fewer than 3 real players are online.
  const players = Number(stats?.player_count ?? 0);
  if (players < 3) {
    toast('Not enough live players in this round. Place a bid in the next round!', true);
    return;
  }
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
    lastBidRoundId = round.id; // track for result popup
    await loadMyBid(round.id);
    await loadStats(round.id);
    // Refresh bots to bid LOWER than player's bid
    simulateBotBids();
    renderPlayers();
    // Refresh wallet immediately (bid amount deducted)
    try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }
    // Mission progress: bid placed
    try { recordMissionEvent('bid', { amount }); } catch (e) {}
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

/** Called when a round settles. Renders winners and the personal popup. */
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
    // Refresh wallet immediately after settlement (win/loss applied)
    try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }
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

  // Show ONLY real winners — no fake bots. If no real winners, show a message.
  const displayWinners = [...(winners || [])];
  // Sort by payout descending
  displayWinners.sort((a, b) => (b.payout_amount ?? b.amount ?? 0) - (a.payout_amount ?? a.amount ?? 0));

  list.innerHTML = '';
  if (!displayWinners.length) {
    list.innerHTML = '<p class="muted center">No winners this round.</p>';
    return;
  }
  displayWinners.slice(0, 10).forEach((w, i) => {
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
  // If bid row not loaded yet, try once more before giving up.
  if (!myBidRow) {
    try { await loadMyBid(settledRoundId); } catch (_) {}
    if (!myBidRow) return; // user didn't play this round
  }

  // Check if round was cancelled (fewer than 3 players) — bids refunded
  try {
    const { data: resCheck } = await supabase.from('round_results')
      .select('id')
      .eq('round_id', settledRoundId)
      .limit(1);
    if (!resCheck || resCheck.length === 0) {
      // Round cancelled: show internal error, bid refunded
      const modal = $('result-modal');
      const card = modal.querySelector('.result-card');
      sounds.lose();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      $('result-emoji').textContent = '⚠️';
      $('result-title').textContent = 'Internal Error';
      $('result-amount').textContent = '';
      $('result-sub').textContent = 'Not enough players. Your bid has been refunded to your wallet.';
      card.classList.add('lost');
      modal.hidden = false;
      setTimeout(() => { modal.hidden = true; }, 5000);
      try { await refreshWallet(); } catch (e) {}
      return;
    }
  } catch (e) { console.warn('cancel check failed', e); }

  let won = null, payout = 0;
  try {
    const { data, error } = await supabase.from('round_results')
      .select('payout').eq('round_id', settledRoundId).eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    const row = unwrapRow(data);
    if (row) { won = true; payout = Number(row.payout || 0); }
    else { won = false; } // bid exists but no winners row -> lost
  } catch (e) {
    console.warn('personal result lookup failed', e);
    // Don't leave the user hanging — assume lost (no winners row found).
    won = false;
  }

  const modal = $('result-modal');
  const card = modal.querySelector('.result-card');
  // Refresh wallet FIRST so the balance shown is current.
  try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }
  if (won === true && payout > 0) {
    sounds.win();
    // Vibrate: celebratory pattern (short-long-short)
    if (navigator.vibrate) navigator.vibrate([100, 50, 200, 50, 300]);
    $('result-emoji').textContent = '🎉';
    $('result-title').textContent = 'You Won!';
    $('result-amount').textContent = '+Rs ' + fmtRs(payout);
    $('result-amount').style.color = '#22c55e';
    $('result-sub').textContent = '+Rs ' + fmtRs(payout) + ' added to your wallet! 🎉';
    card.classList.remove('lost');
    addNotification({ title: '🎉 You Won!', body: '+Rs ' + fmtRs(payout) + ' added to wallet', icon: '🎉', type: 'win' });
    // Mission progress: win
    try { recordMissionEvent('win'); } catch (e) {}
  } else if (won === true) {
    // Edge case: won but payout is 0 — show a generic win popup anyway.
    sounds.win();
    $('result-emoji').textContent = '🎉';
    $('result-title').textContent = 'You Won!';
    $('result-amount').textContent = '';
    $('result-amount').style.color = '#22c55e';
    $('result-sub').textContent = 'Winnings added to your wallet! 🎉';
    card.classList.remove('lost');
    try { recordMissionEvent('win'); } catch (e) {}
  } else if (won === false) {
    sounds.lose();
    // Vibrate: sad pattern (long buzz)
    if (navigator.vibrate) navigator.vibrate([400]);
    const lostAmt = myBidAmount != null ? myBidAmount : 0;
    $('result-emoji').textContent = '😭';
    $('result-title').textContent = 'You Lost';
    $('result-amount').textContent = lostAmt > 0 ? '-Rs ' + fmtRs(lostAmt) : '';
    $('result-amount').style.color = '#ef4444';
    $('result-sub').textContent = lostAmt > 0
      ? '-Rs ' + fmtRs(lostAmt) + ' deducted from your wallet.'
      : 'Better luck next round!';
    card.classList.add('lost');
    if (lostAmt > 0) addNotification({ title: '😭 You Lost', body: '-Rs ' + fmtRs(lostAmt) + ' deducted from wallet', icon: '😭', type: 'loss' });
  } else {
    // Fallback: result not determinable — show a generic round-ended popup.
    $('result-emoji').textContent = '🏁';
    $('result-title').textContent = 'Round Ended';
    $('result-amount').textContent = '';
    $('result-sub').textContent = 'Check your wallet for the updated balance.';
    card.classList.remove('lost');
  }
  // Force the modal visible (override any CSS/display issues).
  modal.hidden = false;
  modal.style.display = 'flex';
  // Results stay 8 seconds, then auto-dismiss.
  setTimeout(() => { modal.hidden = true; modal.style.display = ''; }, 8000);
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
  setInterval(renderActivity, 60000); // refresh the signal each minute

  // Game-side sound toggle (synced with Member Center setting)
  const updateArenaSoundBtn = () => {
    const btn = $('btn-sound-arena');
    if (btn) btn.textContent = isSoundOn() ? '🔊' : '🔇';
  };
  const soundBtn = $('btn-sound-arena');
  if (soundBtn) soundBtn.addEventListener('click', () => {
    unlockAudio();
    setSoundOn(!isSoundOn());
    updateArenaSoundBtn();
    toast(isSoundOn() ? 'Sound on 🔊' : 'Sound off 🔇');
  });
  updateArenaSoundBtn();

  $$('.bid-tab').forEach(tab => tab.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('.bid-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    selectedBid = tab.dataset.amount === 'custom' ? 'custom' : Number(tab.dataset.amount);
    $('custom-bid-row').hidden = selectedBid !== 'custom';
  }));
  const customInput = $('custom-bid-input');
  if (customInput) customInput.addEventListener('input', () => {});

  $('btn-place-bid').addEventListener('click', () => placeBid(false));
  $('btn-free-bid').addEventListener('click', () => placeBid(true));
  $('btn-result-close').addEventListener('click', () => { const m = $('result-modal'); m.hidden = true; m.style.display = ''; });
  $('result-modal').addEventListener('click', (e) => {
    if (e.target.id === 'result-modal') { const m = $('result-modal'); m.hidden = true; m.style.display = ''; }
  });

  loadRound();
  subscribe();
  startChartLive();
  startSettlePoll();
  startWheelLoop(); // roulette wheel visual (rAF-driven)
  // House control API: window.setRouletteResult(7) / ('00') dictates the
  // next landing pocket. Exported from arena.js too.
  window.setRouletteResult = setRouletteResult;
}

export function destroyArena() {
  unsubscribe();
  clearInterval(countdownInt);
  clearInterval(chartTimer);
  stopSettlePoll();
  stopWheelLoop(); // stop the roulette rAF loop
}
