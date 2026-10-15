/* ============================================================
   COIN FLIP — multiplayer, 30-second rounds (like Squad Stakes).
   - cf_get_current_round() -> open round (30s, daily round_no reset)
   - Live side totals via cf_round_stats (polled)
   - cf_place_bid(p_round_id, p_side, p_amount) -> bet on heads/tails
   - Settlement (server-side cf_resolve_round):
       lower-total side WINS; winners get 2x from the losers' pool;
       the remainder is the hidden company fee.
       One side empty or a tie -> round cancelled, bids refunded.
   - Personal result: own cf_bids row (is_winner / payout / refunded).
   - The 3D coin spins and lands on the winning side at settlement.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, unlockAudio, sounds } from './util.js';
import { refreshWallet } from './wallet.js';
import { recordMissionEvent } from './missions.js';

let userId = null;
let round = null;            // current open round row
let choice = null;           // 'heads' | 'tails' (selected side)
let myBid = null;            // my cf_bids row this round
let syncTimer = null;
let clockTimer = null;
let resultShownFor = null;   // round id we already settled in UI
let spinTotal = 0;           // cumulative coin rotateY degrees
let placing = false;

export function setUser(id) { userId = id; }

export function destroyCoinflip() {
  clearInterval(syncTimer); syncTimer = null;
  clearInterval(clockTimer); clockTimer = null;
  round = null; myBid = null; resultShownFor = null;
}

/* ---------------- helpers ---------------- */
function currentAmount() {
  const active = document.querySelector('#cf-tabs .bid-tab.active');
  if (!active) return 10;
  if (active.dataset.amount === 'custom') {
    return Number($('cf-custom-input').value) || 0;
  }
  return Number(active.dataset.amount) || 0;
}

function setResult(html, won) {
  const el = $('cf-result');
  el.innerHTML = html;
  el.className = 'cf-result ' + (won ? 'win' : 'lose');
  el.hidden = false;
}

function renderTotals(h, t) {
  // Store real totals for bot refresh
  $('cf-heads-total').dataset.real = h;
  $('cf-tails-total').dataset.real = t;
  // Add bot amounts for visual liveliness (display only, not in backend)
  const displayH = h + botHeadsTotal;
  const displayT = t + botTailsTotal;
  $('cf-heads-total').textContent = fmtRs(displayH);
  $('cf-tails-total').textContent = fmtRs(displayT);
  const total = displayH + displayT;
  $('cf-tug-fill').style.width = total > 0 ? (displayH / total * 100).toFixed(1) + '%' : '50%';
}

/* BOT SIMULATION (display-only): Simple rule.
   - Player bets on Side A.
   - Bots put MORE on Side A (same side as player).
   - Bots put LESS on Side B.
   - Lower side wins -> player loses.
*/
let botHeadsTotal = 0;
let botTailsTotal = 0;
let realHeadsTotal = 0;
let realTailsTotal = 0;
let realPlayerSide = null;

function simulateCoinFlipBots() {
  botHeadsTotal = 0;
  botTailsTotal = 0;

  if (!myBid) {
    // No player: random 8 bots
    for (let i = 0; i < 8; i++) {
      const amt = 10 + Math.floor(Math.random() * 200);
      if (Math.random() < 0.5) botHeadsTotal += amt;
      else botTailsTotal += amt;
    }
    return;
  }

  // Player exists: bots put amounts CLOSE to player's bid (5-50 Rs diff, realistic)
  const side = myBid.side; // 'heads' or 'tails'
  const pAmt = Number(myBid.amount || 100);
  // 5 bots on player's side: each within 5-50 of player's amount (split)
  for (let i = 0; i < 5; i++) {
    const diff = 5 + Math.floor(Math.random() * 46); // 5-50
    const amt = Math.max(10, Math.floor(pAmt / 5) + (Math.random() < 0.5 ? -diff : diff) / 2);
    if (side === 'heads') botHeadsTotal += Math.max(10, amt);
    else botTailsTotal += Math.max(10, amt);
  }
  // 3 bots on other side: slightly less, still realistic (5-50 diff from player's side total)
  for (let i = 0; i < 3; i++) {
    const diff = 5 + Math.floor(Math.random() * 46); // 5-50
    const amt = Math.max(10, Math.floor(pAmt / 4) - diff / 3);
    if (side === 'heads') botTailsTotal += Math.max(10, amt);
    else botHeadsTotal += Math.max(10, amt);
  }
}

function updateRealPlayerSide() {
  realPlayerSide = myBid ? myBid.side : null;
  simulateCoinFlipBots();
}

// Refresh bots periodically
setInterval(() => {
  if (round && !document.hidden) {
    simulateCoinFlipBots();
    const h = Number($('cf-heads-total').dataset.real || 0);
    const t = Number($('cf-tails-total').dataset.real || 0);
    renderTotals(h, t);
  }
}, 5000);

function renderMyBet() {
  $('cf-my-bet').textContent = myBid
    ? (myBid.side === 'heads' ? '👑 HEADS' : '🦅 TAILS') + ' · Rs ' + fmtRs(myBid.amount)
    : '—';
}

/* Spin the 3D coin and land on `side` ('heads' | 'tails' | null). */
function spinCoinTo(side) {
  const coin = $('cf-coin');
  if (!coin) return Promise.resolve();
  coin.style.transition = 'none';
  coin.style.transform = 'rotateY(' + (spinTotal % 360) + 'deg)';
  void coin.offsetWidth;
  coin.style.transition = '';
  const base = spinTotal + 1800;
  const rem = ((base % 360) + 360) % 360;
  // null (cancelled): land back on heads, fewer spins
  const target = side === 'tails' ? 180 : 0;
  const adjust = (target - rem + 360) % 360;
  spinTotal = base + adjust;
  coin.style.transform = 'rotateY(' + spinTotal + 'deg)';
  return new Promise(r => setTimeout(r, 2500));
}

/* ---------------- data ---------------- */
async function fetchRound() {
  const { data, error } = await supabase.rpc('cf_get_current_round');
  if (error) throw error;
  return unwrapRow(data);
}

async function loadStats(roundId) {
  try {
    const { data } = await supabase.from('cf_round_stats')
      .select('*').eq('round_id', roundId).maybeSingle();
    const s = unwrapRow(data);
    if (s && (!round || s.round_id === round.id)) {
      renderTotals(Number(s.heads_total || 0), Number(s.tails_total || 0));
    }
  } catch (e) { console.warn('cf_round_stats read failed', e); }
}

async function loadMyBid(roundId) {
  try {
    const { data } = await supabase.from('cf_bids')
      .select('*').eq('round_id', roundId).eq('user_id', userId).maybeSingle();
    myBid = unwrapRow(data);
  } catch (e) { console.warn('cf my bid read failed', e); myBid = null; }
  renderMyBet();
  updateRealPlayerSide();
}

async function loadHistory() {
  const list = $('cf-history');
  try {
    const { data } = await supabase.from('public_cf_rounds')
      .select('round_no, winning_side')
      .eq('status', 'closed')
      .order('starts_at', { ascending: false })
      .limit(10);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      list.innerHTML = '<p class="muted center">No rounds yet 🪙</p>';
      return;
    }
    list.innerHTML = '';
    rows.forEach(r => {
      const chip = document.createElement('span');
      const ws = r.winning_side;
      chip.className = 'flip-chip ' + (ws ? 'won' : 'lost');
      chip.innerHTML = ws === 'heads' ? '👑 H' : ws === 'tails' ? '🦅 T' : '–';
      chip.title = 'Round #' + r.round_no + (ws ? ' · ' + ws + ' won' : ' · cancelled');
      list.appendChild(chip);
    });
  } catch (e) { console.warn('cf history failed', e); }
}

/* ---------------- round lifecycle ---------------- */
function onNewRound(r) {
  round = r;
  myBid = null;
  resultShownFor = null;
  choice = null;
  $('cf-heads').classList.remove('selected');
  $('cf-tails').classList.remove('selected');
  $('cf-result').hidden = true;
  document.querySelector('.heads-side')?.classList.remove('winning');
  document.querySelector('.tails-side')?.classList.remove('winning');
  $('cf-round-no').textContent = '#' + (r.round_no ?? '–');
  renderTotals(Number(r.heads_total || 0), Number(r.tails_total || 0));
  renderMyBet();
  $('btn-cf-bet').disabled = false;
  loadMyBid(r.id);
  loadStats(r.id);
}

async function onSettled(closedRoundId) {
  if (resultShownFor === closedRoundId) return;
  resultShownFor = closedRoundId;
  // Note: bet button stays enabled — the <3-player check in placeBet shows
  // "Round is full! Place your bid in the next round." when tapped.

  // Final authoritative state of the settled round.
  let fin = null;
  try {
    const { data } = await supabase.from('public_cf_rounds')
      .select('*').eq('id', closedRoundId).maybeSingle();
    fin = unwrapRow(data);
  } catch (e) { console.warn('cf final round read failed', e); }

  const winningSide = fin?.winning_side || null;
  renderTotals(Number(fin?.heads_total || 0), Number(fin?.tails_total || 0));

  // Re-read my bid row — after settlement it carries is_winner/payout/refunded.
  await loadMyBid(closedRoundId);

  await spinCoinTo(winningSide);

  if (winningSide) {
    document.querySelector(winningSide === 'heads' ? '.heads-side' : '.tails-side')
      ?.classList.add('winning');
  }

  if (!myBid) {
    // Spectator: nothing personal to show.
  } else if (myBid.refunded) {
    setResult('⚠️ Round cancelled — your bet of Rs ' + fmtRs(myBid.amount) + ' was refunded.', false);
  } else if (myBid.is_winner) {
    sounds.win();
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    try { recordMissionEvent('win'); } catch (e) {}
    setResult(
      '🎉 <strong>' + String(winningSide).toUpperCase() + ' WINS!</strong> ' +
      '<strong style="color:#22c55e">+Rs ' + fmtRs(myBid.payout) + '</strong> added to wallet!' +
      (Math.abs(Number(myBid.payout) - 2 * Number(myBid.amount)) < 0.01 ? ' (2x)!' : '!'),
      true
    );
  } else {
    sounds.lose();
    if (navigator.vibrate) navigator.vibrate(150);
    setResult(
      '😞 <strong>' + String(winningSide).toUpperCase() + '</strong> had the lower total. ' +
      '<strong style="color:#ef4444">-Rs ' + fmtRs(myBid.amount) + '</strong> deducted from wallet.',
      false
    );
  }

  try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }
  loadHistory();
}

async function sync() {
  try {
    const r = await fetchRound();
    if (!r) return;
    if (!round || r.id !== round.id) {
      const prevId = round?.id;
      onNewRound(r);
      // The previous round just settled (get_current_round resolves due rounds).
      if (prevId && prevId !== r.id) onSettled(prevId);
    } else {
      // Same round: keep totals fresh.
      renderTotals(Number(r.heads_total || 0), Number(r.tails_total || 0));
    }
  } catch (e) { console.warn('cf sync failed', e); }
}

function tickClock() {
  if (!round?.ends_at) { $('cf-clock-time').textContent = '--:--'; return; }
  const ms = new Date(round.ends_at).getTime() - Date.now();
  const s = Math.max(0, Math.ceil(ms / 1000));
  $('cf-clock-time').textContent =
    String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/* ---------------- betting ---------------- */
async function placeBet() {
  if (placing) return;
  unlockAudio();
  if (!round?.id) { toast('Round is loading — wait a second…', true); return; }
  if (!choice) { toast('Pick HEADS or TAILS first! 🪙', true); return; }
  // Same rule as all games: min 3 real players
  try {
    const { data: bidRows } = await supabase.from('cf_bids').select('user_id').eq('round_id', round.id);
    const uniquePlayers = new Set((bidRows || []).map(b => b.user_id)).size;
    if (uniquePlayers < 2) { // <2 existing + you = <3 total
      toast('Round is full! Place your bid in the next round.', true);
      return;
    }
  } catch (e) { /* allow bid if check fails */ }
  const amount = currentAmount();
  if (!amount || amount < 10) { toast('Minimum bet is Rs 10.', true); return; }
  if (amount > 100000) { toast('Maximum bet is Rs 100,000.', true); return; }

  placing = true;
  $('btn-cf-bet').disabled = true;
  try {
    const { data, error } = await supabase.rpc('cf_place_bid', {
      p_round_id: round.id, p_side: choice, p_amount: amount,
    });
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || row.ok === false) throw new Error(row?.error || 'Bet rejected');
    sounds.click();
    toast('⚡ Rs ' + fmtRs(amount) + ' on ' + choice.toUpperCase() + '!');
    await loadMyBid(round.id);
    await loadStats(round.id);
    try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }
    try { recordMissionEvent('bid', { amount }); } catch (e) {}
  } catch (e) {
    toast(friendlyError(e, 'Bet failed. Try again.'), true);
    if (!myBid) $('btn-cf-bet').disabled = false;
  } finally {
    placing = false;
  }
}

/* ---------------- init ---------------- */
export function initCoinflip() {
  try { refreshWallet().catch(() => {}); } catch (e) {}
  $('cf-heads').addEventListener('click', () => {
    unlockAudio(); sounds.click();
    choice = 'heads';
    $('cf-heads').classList.add('selected');
    $('cf-tails').classList.remove('selected');
  });
  $('cf-tails').addEventListener('click', () => {
    unlockAudio(); sounds.click();
    choice = 'tails';
    $('cf-tails').classList.add('selected');
    $('cf-heads').classList.remove('selected');
  });

  $$('#cf-tabs .bid-tab').forEach(t => t.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('#cf-tabs .bid-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('cf-custom-row').hidden = t.dataset.amount !== 'custom';
  }));

  $('btn-cf-bet').addEventListener('click', placeBet);

  clearInterval(syncTimer);
  clearInterval(clockTimer);
  sync();
  syncTimer = setInterval(sync, 3000);
  clockTimer = setInterval(tickClock, 500);
  loadHistory();
}
