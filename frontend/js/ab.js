/* ============================================================
   ANDAR BAHAR — multiplayer, 30-second rounds (like Coin Flip).
   - ab_get_current_round() -> open round (30s, daily round_no reset)
   - Live side totals via ab_round_stats (polled)
   - ab_place_bid(p_round_id, p_side, p_amount) -> bet on andar/bahar
   - Settlement (server-side ab_resolve_round):
       lower-total side WINS; winners get 2x from the losers' pool;
       the remainder is the hidden company fee.
       One side empty -> ALL on the other side LOSE (same-side rule).
       Exact tie -> round cancelled, bids refunded.
   - Personal result: own ab_bids row (is_winner / payout / refunded).
   - The dealer card flips to reveal the winning side at settlement.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, unlockAudio, sounds } from './util.js';
import { refreshWallet } from './wallet.js';
import { recordMissionEvent } from './missions.js';

let userId = null;
let round = null;            // current open round row
let choice = null;           // 'andar' | 'bahar' (selected side)
let myBid = null;            // my ab_bids row this round
let syncTimer = null;
let clockTimer = null;
let resultShownFor = null;   // round id we already settled in UI
let placing = false;

export function setUser(id) { userId = id; }

export function destroyAndarBahar() {
  clearInterval(syncTimer); syncTimer = null;
  clearInterval(clockTimer); clockTimer = null;
  round = null; myBid = null; resultShownFor = null;
}

/* ---------------- helpers ---------------- */
function currentAmount() {
  const active = document.querySelector('#ab-tabs .bid-tab.active');
  if (!active) return 10;
  if (active.dataset.amount === 'custom') {
    return Number($('ab-custom-input').value) || 0;
  }
  return Number(active.dataset.amount) || 0;
}

function setResult(html, won) {
  const el = $('ab-result');
  el.innerHTML = html;
  el.className = 'ab-result ' + (won ? 'win' : 'lose');
  el.hidden = false;
}

function renderTotals(a, b) {
  // Store real totals for bot refresh
  $('ab-andar-total').dataset.real = a;
  $('ab-bahar-total').dataset.real = b;
  // Add bot amounts for visual liveliness (display only, not in backend)
  const displayA = a + botAndarTotal;
  const displayB = b + botBaharTotal;
  $('ab-andar-total').textContent = fmtRs(displayA);
  $('ab-bahar-total').textContent = fmtRs(displayB);
  const total = displayA + displayB;
  $('ab-tug-fill').style.width = total > 0 ? (displayA / total * 100).toFixed(1) + '%' : '50%';
}

/* BOT SIMULATION (display-only): Simple rule.
   - Player bets on Side A.
   - Bots put MORE on Side A (same side as player).
   - Bots put LESS on Side B.
   - Lower side wins -> player loses.
*/
let botAndarTotal = 0;
let botBaharTotal = 0;

function simulateAndarBaharBots() {
  botAndarTotal = 0;
  botBaharTotal = 0;

  if (!myBid) {
    // No player: random 8 bots
    for (let i = 0; i < 8; i++) {
      const amt = 10 + Math.floor(Math.random() * 200);
      if (Math.random() < 0.5) botAndarTotal += amt;
      else botBaharTotal += amt;
    }
    return;
  }

  // Player exists: bots put MORE on player's side, LESS on other side
  const side = myBid.side; // 'andar' or 'bahar'
  // 5 bots on player's side (more money)
  for (let i = 0; i < 5; i++) {
    const amt = 20 + Math.floor(Math.random() * 150); // 20-170
    if (side === 'andar') botAndarTotal += amt;
    else botBaharTotal += amt;
  }
  // 3 bots on other side (less money)
  for (let i = 0; i < 3; i++) {
    const amt = 10 + Math.floor(Math.random() * 50); // 10-60
    if (side === 'andar') botBaharTotal += amt;
    else botAndarTotal += amt;
  }
}

// Refresh bots periodically
setInterval(() => {
  if (round && !document.hidden) {
    simulateAndarBaharBots();
    const a = Number($('ab-andar-total').dataset.real || 0);
    const b = Number($('ab-bahar-total').dataset.real || 0);
    renderTotals(a, b);
  }
}, 5000);

function renderMyBet() {
  $('ab-my-bet').textContent = myBid
    ? (myBid.side === 'andar' ? '🃏 ANDAR' : '🎴 BAHAR') + ' · Rs ' + fmtRs(myBid.amount)
    : '—';
}

/* Reveal the winning side on the dealer card (simple flip). */
function revealCardsTo(side) {
  const joker = $('ab-joker');
  if (!joker) return Promise.resolve();
  const back = joker.querySelector('.ab-card-back');
  if (back) {
    back.innerHTML = side === 'andar'
      ? '<span>🃏</span><em>ANDAR WINS</em>'
      : side === 'bahar'
        ? '<span>🎴</span><em>BAHAR WINS</em>'
        : '<span>🂠</span><em>CANCELLED</em>';
  }
  joker.classList.remove('flipped');
  void joker.offsetWidth;
  joker.classList.add('flipped');
  return new Promise(r => setTimeout(r, 900));
}

/* ---------------- data ---------------- */
async function fetchRound() {
  const { data, error } = await supabase.rpc('ab_get_current_round');
  if (error) throw error;
  return unwrapRow(data);
}

async function loadStats(roundId) {
  try {
    const { data } = await supabase.from('ab_round_stats')
      .select('*').eq('round_id', roundId).maybeSingle();
    const s = unwrapRow(data);
    if (s && (!round || s.round_id === round.id)) {
      renderTotals(Number(s.andar_total || 0), Number(s.bahar_total || 0));
    }
  } catch (e) { console.warn('ab_round_stats read failed', e); }
}

async function loadMyBid(roundId) {
  try {
    const { data } = await supabase.from('ab_bids')
      .select('*').eq('round_id', roundId).eq('user_id', userId).maybeSingle();
    myBid = unwrapRow(data);
  } catch (e) { console.warn('ab my bid read failed', e); myBid = null; }
  renderMyBet();
  simulateAndarBaharBots();
}

async function loadHistory() {
  const list = $('ab-history');
  try {
    const { data } = await supabase.from('public_ab_rounds')
      .select('round_no, winning_side')
      .eq('status', 'closed')
      .order('starts_at', { ascending: false })
      .limit(10);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      list.innerHTML = '<p class="muted center">No rounds yet 🃏</p>';
      return;
    }
    list.innerHTML = '';
    rows.forEach(r => {
      const chip = document.createElement('span');
      const ws = r.winning_side;
      chip.className = 'ab-chip ' + (ws ? 'won' : 'lost');
      chip.innerHTML = ws === 'andar' ? '🃏 A' : ws === 'bahar' ? '🎴 B' : '–';
      chip.title = 'Round #' + r.round_no + (ws ? ' · ' + ws + ' won' : ' · cancelled');
      list.appendChild(chip);
    });
  } catch (e) { console.warn('ab history failed', e); }
}

/* ---------------- round lifecycle ---------------- */
function onNewRound(r) {
  round = r;
  myBid = null;
  resultShownFor = null;
  choice = null;
  $('ab-andar').classList.remove('selected');
  $('ab-bahar').classList.remove('selected');
  $('ab-result').hidden = true;
  document.querySelector('.andar-side')?.classList.remove('winning');
  document.querySelector('.bahar-side')?.classList.remove('winning');
  const joker = $('ab-joker');
  if (joker) {
    joker.classList.remove('flipped');
    const back = joker.querySelector('.ab-card-back');
    if (back) back.innerHTML = '<span>🂠</span><em>?</em>';
  }
  $('ab-round-no').textContent = '#' + (r.round_no ?? '–');
  renderTotals(Number(r.andar_total || 0), Number(r.bahar_total || 0));
  renderMyBet();
  $('btn-ab-bet').disabled = false;
  loadMyBid(r.id);
  loadStats(r.id);
}

async function onSettled(closedRoundId) {
  if (resultShownFor === closedRoundId) return;
  resultShownFor = closedRoundId;
  $('btn-ab-bet').disabled = true;

  // Final authoritative state of the settled round.
  let fin = null;
  try {
    const { data } = await supabase.from('public_ab_rounds')
      .select('*').eq('id', closedRoundId).maybeSingle();
    fin = unwrapRow(data);
  } catch (e) { console.warn('ab final round read failed', e); }

  const winningSide = fin?.winning_side || null;
  renderTotals(Number(fin?.andar_total || 0), Number(fin?.bahar_total || 0));

  // Re-read my bid row — after settlement it carries is_winner/payout/refunded.
  await loadMyBid(closedRoundId);

  await revealCardsTo(winningSide);

  if (winningSide) {
    document.querySelector(winningSide === 'andar' ? '.andar-side' : '.bahar-side')
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
      'You won <strong>Rs ' + fmtRs(myBid.payout) + '</strong>' +
      (Math.abs(Number(myBid.payout) - 2 * Number(myBid.amount)) < 0.01 ? ' (2x)!' : '!'),
      true
    );
  } else {
    sounds.lose();
    if (navigator.vibrate) navigator.vibrate(150);
    setResult(
      '😞 <strong>' + String(winningSide).toUpperCase() + '</strong> had the lower total. ' +
      'Lost Rs ' + fmtRs(myBid.amount) + ' — better luck next round!',
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
      renderTotals(Number(r.andar_total || 0), Number(r.bahar_total || 0));
    }
  } catch (e) { console.warn('ab sync failed', e); }
}

function tickClock() {
  if (!round?.ends_at) { $('ab-clock-time').textContent = '--:--'; return; }
  const ms = new Date(round.ends_at).getTime() - Date.now();
  const s = Math.max(0, Math.ceil(ms / 1000));
  $('ab-clock-time').textContent =
    String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/* ---------------- betting ---------------- */
async function placeBet() {
  if (placing) return;
  unlockAudio();
  if (!round?.id) { toast('Round is loading — wait a second…', true); return; }
  if (!choice) { toast('Pick ANDAR or BAHAR first! 🃏', true); return; }
  const amount = currentAmount();
  if (!amount || amount < 10) { toast('Minimum bet is Rs 10.', true); return; }
  if (amount > 100000) { toast('Maximum bet is Rs 100,000.', true); return; }

  placing = true;
  $('btn-ab-bet').disabled = true;
  try {
    const { data, error } = await supabase.rpc('ab_place_bid', {
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
    if (!myBid) $('btn-ab-bet').disabled = false;
  } finally {
    placing = false;
  }
}

/* ---------------- init ---------------- */
export function initAndarBahar() {
  $('ab-andar').addEventListener('click', () => {
    unlockAudio(); sounds.click();
    choice = 'andar';
    $('ab-andar').classList.add('selected');
    $('ab-bahar').classList.remove('selected');
  });
  $('ab-bahar').addEventListener('click', () => {
    unlockAudio(); sounds.click();
    choice = 'bahar';
    $('ab-bahar').classList.add('selected');
    $('ab-andar').classList.remove('selected');
  });

  $$('#ab-tabs .bid-tab').forEach(t => t.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('#ab-tabs .bid-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('ab-custom-row').hidden = t.dataset.amount !== 'custom';
  }));

  $('btn-ab-bet').addEventListener('click', placeBet);

  clearInterval(syncTimer);
  clearInterval(clockTimer);
  sync();
  syncTimer = setInterval(sync, 3000);
  clockTimer = setInterval(tickClock, 500);
  loadHistory();
}
