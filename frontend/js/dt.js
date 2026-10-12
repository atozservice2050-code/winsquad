/* ============================================================
   DRAGON TIGER — multiplayer, 30-second rounds (like Coin Flip).
   - dt_get_current_round() -> open round (30s, daily round_no reset)
   - Live side totals via dt_round_stats (polled)
   - dt_place_bid(p_round_id, p_side, p_amount) -> bet on dragon/tiger
   - Settlement (server-side dt_resolve_round):
       lower-total side WINS; winners get 2x from the losers' pool;
       the remainder is the hidden company fee.
       Same-side -> all lose. Exact tie -> refund.
   - One card dealt per side at settlement; the winning side always
     holds the higher card (visual reveal matches the outcome).
   - Personal result: own dt_bids row (is_winner / payout / refunded).
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, unlockAudio, sounds } from './util.js';
import { refreshWallet } from './wallet.js';
import { recordMissionEvent } from './missions.js';

let userId = null;
let round = null;            // current open round row
let choice = null;           // 'dragon' | 'tiger' (selected side)
let myBid = null;            // my dt_bids row this round
let syncTimer = null;
let clockTimer = null;
let resultShownFor = null;   // round id we already settled in UI
let placing = false;

export function setUser(id) { userId = id; }

export function destroyDT() {
  clearInterval(syncTimer); syncTimer = null;
  clearInterval(clockTimer); clockTimer = null;
  round = null; myBid = null; resultShownFor = null;
}

/* ---------------- helpers ---------------- */
function currentAmount() {
  const active = document.querySelector('#dt-tabs .bid-tab.active');
  if (!active) return 10;
  if (active.dataset.amount === 'custom') {
    return Number($('dt-custom-input').value) || 0;
  }
  return Number(active.dataset.amount) || 0;
}

function setResult(html, won) {
  const el = $('dt-result');
  el.innerHTML = html;
  el.className = 'dt-result ' + (won ? 'win' : 'lose');
  el.hidden = false;
}

function renderTotals(d, t) {
  // Store real totals for bot refresh
  $('dt-dragon-total').dataset.real = d;
  $('dt-tiger-total').dataset.real = t;
  // Add bot amounts for visual liveliness (display only, not in backend)
  const displayD = d + botDragonTotal;
  const displayT = t + botTigerTotal;
  $('dt-dragon-total').textContent = fmtRs(displayD);
  $('dt-tiger-total').textContent = fmtRs(displayT);
  const total = displayD + displayT;
  $('dt-tug-fill').style.width = total > 0 ? (displayD / total * 100).toFixed(1) + '%' : '50%';
}

/* BOT SIMULATION (display-only): Simple rule.
   - Player bets on Side A.
   - Bots put MORE on Side A (same side as player).
   - Bots put LESS on Side B.
   - Lower side wins -> player loses.
*/
let botDragonTotal = 0;
let botTigerTotal = 0;
let realPlayerSide = null;

function simulateDTBots() {
  botDragonTotal = 0;
  botTigerTotal = 0;

  if (!myBid) {
    // No player: random 8 bots
    for (let i = 0; i < 8; i++) {
      const amt = 10 + Math.floor(Math.random() * 200);
      if (Math.random() < 0.5) botDragonTotal += amt;
      else botTigerTotal += amt;
    }
    return;
  }

  // Player exists: bots put MORE on player's side, LESS on other side
  const side = myBid.side; // 'dragon' or 'tiger'
  // 5 bots on player's side (more money)
  for (let i = 0; i < 5; i++) {
    const amt = 20 + Math.floor(Math.random() * 150); // 20-170
    if (side === 'dragon') botDragonTotal += amt;
    else botTigerTotal += amt;
  }
  // 3 bots on other side (less money)
  for (let i = 0; i < 3; i++) {
    const amt = 10 + Math.floor(Math.random() * 50); // 10-60
    if (side === 'dragon') botTigerTotal += amt;
    else botDragonTotal += amt;
  }
}

function updateRealPlayerSide() {
  realPlayerSide = myBid ? myBid.side : null;
  simulateDTBots();
}

// Refresh bots periodically
const botTimer = setInterval(() => {
  if (round && !document.hidden && $('dt-dragon-total')) {
    simulateDTBots();
    const d = Number($('dt-dragon-total').dataset.real || 0);
    const t = Number($('dt-tiger-total').dataset.real || 0);
    renderTotals(d, t);
  }
}, 5000);

function renderMyBet() {
  $('dt-my-bet').textContent = myBid
    ? (myBid.side === 'dragon' ? '🐉 DRAGON' : '🐯 TIGER') + ' · Rs ' + fmtRs(myBid.amount)
    : '—';
}

/* Reset both cards to face-down. */
function resetCards() {
  ['dragon', 'tiger'].forEach(side => {
    const card = $('dt-card-' + side);
    if (!card) return;
    card.classList.remove('flipped', 'winner');
    const face = card.querySelector('.dt-card-front span');
    if (face) face.textContent = '🂠';
  });
}

/* Flip both cards over to reveal the dealt cards. */
function revealCards(dragonCard, tigerCard, winningSide) {
  const set = (side, text) => {
    const card = $('dt-card-' + side);
    if (!card) return;
    const face = card.querySelector('.dt-card-front span');
    if (face && text) face.textContent = text;
  };
  set('dragon', dragonCard);
  set('tiger', tigerCard);
  return new Promise(resolve => {
    setTimeout(() => {
      $('dt-card-dragon')?.classList.add('flipped');
      setTimeout(() => {
        $('dt-card-tiger')?.classList.add('flipped');
        if (winningSide) {
          setTimeout(() => {
            $('dt-card-' + winningSide)?.classList.add('winner');
            document.querySelector(winningSide === 'dragon' ? '.dragon-side' : '.tiger-side')
              ?.classList.add('winning');
          }, 600);
        }
        setTimeout(resolve, 1200);
      }, 500);
    }, 400);
  });
}

/* ---------------- data ---------------- */
async function fetchRound() {
  const { data, error } = await supabase.rpc('dt_get_current_round');
  if (error) throw error;
  return unwrapRow(data);
}

async function loadStats(roundId) {
  try {
    const { data } = await supabase.from('dt_round_stats')
      .select('*').eq('round_id', roundId).maybeSingle();
    const s = unwrapRow(data);
    if (s && (!round || s.round_id === round.id)) {
      renderTotals(Number(s.dragon_total || 0), Number(s.tiger_total || 0));
    }
  } catch (e) { console.warn('dt_round_stats read failed', e); }
}

async function loadMyBid(roundId) {
  try {
    const { data } = await supabase.from('dt_bids')
      .select('*').eq('round_id', roundId).eq('user_id', userId).maybeSingle();
    myBid = unwrapRow(data);
  } catch (e) { console.warn('dt my bid read failed', e); myBid = null; }
  renderMyBet();
  updateRealPlayerSide();
}

async function loadHistory() {
  const list = $('dt-history');
  try {
    const { data } = await supabase.from('public_dt_rounds')
      .select('round_no, winning_side')
      .eq('status', 'closed')
      .order('starts_at', { ascending: false })
      .limit(10);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      list.innerHTML = '<p class="muted center">No rounds yet 🐉🐯</p>';
      return;
    }
    list.innerHTML = '';
    rows.forEach(r => {
      const chip = document.createElement('span');
      const ws = r.winning_side;
      chip.className = 'dt-chip ' + (ws ? 'won' : 'lost');
      chip.innerHTML = ws === 'dragon' ? '🐉 D' : ws === 'tiger' ? '🐯 T' : '–';
      chip.title = 'Round #' + r.round_no + (ws ? ' · ' + ws + ' won' : ' · cancelled');
      list.appendChild(chip);
    });
  } catch (e) { console.warn('dt history failed', e); }
}

/* ---------------- round lifecycle ---------------- */
function onNewRound(r) {
  round = r;
  myBid = null;
  resultShownFor = null;
  choice = null;
  $('dt-dragon').classList.remove('selected');
  $('dt-tiger').classList.remove('selected');
  $('dt-result').hidden = true;
  document.querySelector('.dragon-side')?.classList.remove('winning');
  document.querySelector('.tiger-side')?.classList.remove('winning');
  $('dt-round-no').textContent = '#' + (r.round_no ?? '–');
  resetCards();
  renderTotals(Number(r.dragon_total || 0), Number(r.tiger_total || 0));
  renderMyBet();
  $('btn-dt-bet').disabled = false;
  loadMyBid(r.id);
  loadStats(r.id);
}

async function onSettled(closedRoundId) {
  if (resultShownFor === closedRoundId) return;
  resultShownFor = closedRoundId;
  $('btn-dt-bet').disabled = true;

  // Final authoritative state of the settled round.
  let fin = null;
  try {
    const { data } = await supabase.from('public_dt_rounds')
      .select('*').eq('id', closedRoundId).maybeSingle();
    fin = unwrapRow(data);
  } catch (e) { console.warn('dt final round read failed', e); }

  const winningSide = fin?.winning_side || null;
  renderTotals(Number(fin?.dragon_total || 0), Number(fin?.tiger_total || 0));

  // Re-read my bid row — after settlement it carries is_winner/payout/refunded.
  await loadMyBid(closedRoundId);

  await revealCards(fin?.dragon_card, fin?.tiger_card, winningSide);

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
      'You won <strong>Rs ' + fmtRs(myBid.payout) + '</strong> (2x)!',
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
      renderTotals(Number(r.dragon_total || 0), Number(r.tiger_total || 0));
    }
  } catch (e) { console.warn('dt sync failed', e); }
}

function tickClock() {
  if (!round?.ends_at) { $('dt-clock-time').textContent = '--:--'; return; }
  const ms = new Date(round.ends_at).getTime() - Date.now();
  const s = Math.max(0, Math.ceil(ms / 1000));
  $('dt-clock-time').textContent =
    String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/* ---------------- betting ---------------- */
async function placeBet() {
  if (placing) return;
  unlockAudio();
  if (!round?.id) { toast('Round is loading — wait a second…', true); return; }
  if (!choice) { toast('Pick DRAGON or TIGER first! 🐉🐯', true); return; }
  const amount = currentAmount();
  if (!amount || amount < 10) { toast('Minimum bet is Rs 10.', true); return; }
  if (amount > 100000) { toast('Maximum bet is Rs 100,000.', true); return; }

  placing = true;
  $('btn-dt-bet').disabled = true;
  try {
    const { data, error } = await supabase.rpc('dt_place_bid', {
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
    if (!myBid) $('btn-dt-bet').disabled = false;
  } finally {
    placing = false;
  }
}

/* ---------------- init ---------------- */
export function initDT() {
  $('dt-dragon').addEventListener('click', () => {
    unlockAudio(); sounds.click();
    choice = 'dragon';
    $('dt-dragon').classList.add('selected');
    $('dt-tiger').classList.remove('selected');
  });
  $('dt-tiger').addEventListener('click', () => {
    unlockAudio(); sounds.click();
    choice = 'tiger';
    $('dt-tiger').classList.add('selected');
    $('dt-dragon').classList.remove('selected');
  });

  $$('#dt-tabs .bid-tab').forEach(t => t.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('#dt-tabs .bid-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('dt-custom-row').hidden = t.dataset.amount !== 'custom';
  }));

  $('btn-dt-bet').addEventListener('click', placeBet);

  clearInterval(syncTimer);
  clearInterval(clockTimer);
  sync();
  syncTimer = setInterval(sync, 3000);
  clockTimer = setInterval(tickClock, 500);
  loadHistory();
}
