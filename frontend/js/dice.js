/* ============================================================
   DICE (7 UP DOWN) — multiplayer dice game, 15-second rounds.
   - dice_get_current_round() -> open round (15s, daily round_no reset)
   - Live option totals via dice_round_stats (polled)
   - dice_place_bid(p_round_id, p_option, p_amount) -> bet on an option
   - Options: UNDER 7 (total 2-6) · EXACTLY 7 · OVER 7 (total 8-12)
   - Settlement (server-side dice_resolve_round):
       lowest-total option WINS; winners get 2x (UNDER/OVER) or 5x (EXACTLY 7)
       from the losers' pool (proportional split if the pool is too small);
       the remainder is the hidden company fee.
       Single option with all bids -> everyone loses (money to company).
       Fewer than 3 bids -> round cancelled, bids refunded.
       The dice shown are DISPLAY-ONLY, picked to match the winning option.
   - Personal result: own dice_bids row (is_winner / payout / refunded).
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, unlockAudio, sounds, isSoundOn, setSoundOn } from './util.js';
import { refreshWallet } from './wallet.js';
import { recordMissionEvent } from './missions.js';
import { addNotification } from './notifications.js';

// 3 betting options.
const OPTIONS = [
  { id: 'under7', emoji: '⬇️', name: 'UNDER 7',  range: '2–6' },
  { id: 'seven',  emoji: '🎯', name: 'EXACTLY 7', range: '7' },
  { id: 'over7',  emoji: '⬆️', name: 'OVER 7',   range: '8–12' },
];

// Pip positions (3x3 grid indices) for each die face.
const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

let userId = null;
let round = null;            // current open round row
let choice = null;           // selected option id
let myBid = null;            // my dice_bids row this round
let syncTimer = null;
let clockTimer = null;
let rollTimer = null;
let resultShownFor = null;   // round id we already settled in UI
let placing = false;
let optTotals = {};          // real totals per option (from stats)
let botTotals = {};          // display-only bot totals per option

export function setUser(id) { userId = id; }

export function destroyDice() {
  clearInterval(syncTimer); syncTimer = null;
  clearInterval(clockTimer); clockTimer = null;
  clearInterval(rollTimer); rollTimer = null;
  round = null; myBid = null; resultShownFor = null;
}

/* ---------------- helpers ---------------- */
function currentAmount() {
  const active = document.querySelector('#d7-tabs .bid-tab.active');
  if (!active) return 10;
  if (active.dataset.amount === 'custom') {
    return Number($('d7-custom-input').value) || 0;
  }
  return Number(active.dataset.amount) || 0;
}

function setResult(html, won) {
  const el = $('d7-result');
  el.innerHTML = html;
  el.className = 'cf-result ' + (won ? 'win' : 'lose');
  el.hidden = false;
}

function optById(id) { return OPTIONS.find(o => o.id === id); }

function renderDie(el, value) {
  el.innerHTML = '';
  const pips = PIPS[value] || [];
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('span');
    cell.className = 'd7-pip-cell' + (pips.includes(i) ? ' on' : '');
    el.appendChild(cell);
  }
}

function setDice(d1, d2) {
  renderDie($('d7-dice1'), d1);
  renderDie($('d7-dice2'), d2);
  $('d7-dice-total').textContent = (d1 && d2) ? (d1 + d2) : '–';
}

/* Rolling animation: dice tumble with random faces, then settle. */
function rollDiceTo(d1, d2) {
  clearInterval(rollTimer);
  return new Promise(resolve => {
    rollTimer = setInterval(() => {
      setDice(1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6));
    }, 90);
    setTimeout(() => {
      clearInterval(rollTimer);
      setDice(d1, d2);
      resolve();
    }, 1300);
  });
}

function renderOptions() {
  const grid = $('d7-options');
  grid.innerHTML = '';
  OPTIONS.forEach(o => {
    const real = Number(optTotals[o.id] || 0);
    const bots = Number(botTotals[o.id] || 0);
    const btn = document.createElement('button');
    btn.className = 'd7-opt-btn' + (choice === o.id ? ' selected' : '');
    btn.dataset.opt = o.id;
    btn.innerHTML =
      '<span class="d7-opt-emoji">' + o.emoji + '</span>' +
      '<span class="d7-opt-name">' + o.name + '</span>' +
      '<span class="d7-opt-range">Total ' + o.range + '</span>' +
      '<span class="d7-opt-total">Rs ' + fmtRs(real + bots) + '</span>';
    btn.addEventListener('click', () => {
      unlockAudio(); sounds.click();
      choice = o.id;
      $$('#d7-options .d7-opt-btn').forEach(x => x.classList.remove('selected'));
      btn.classList.add('selected');
    });
    grid.appendChild(btn);
  });
}

/* BOT SIMULATION (display-only): same rule as other games.
   - Player bets on Option A.
   - Bots put MORE on Option A (same option as player).
   - Bots put LESS on the other options.
   - Lowest option wins -> player loses.
   - Bot amounts stay realistic: within 5-50 Rs of the player's bid.
*/
function simulateDiceBots() {
  OPTIONS.forEach(o => { botTotals[o.id] = 0; });

  if (!myBid) {
    // No player: 8 random bots spread across options.
    for (let i = 0; i < 8; i++) {
      const amt = 10 + Math.floor(Math.random() * 200);
      const o = OPTIONS[Math.floor(Math.random() * OPTIONS.length)];
      botTotals[o.id] += amt;
    }
    return;
  }

  const pAmt = Number(myBid.amount || 100);
  // 5 bots on the player's option: amounts near the player's bid (5-50 Rs diff).
  for (let i = 0; i < 5; i++) {
    const diff = 5 + Math.floor(Math.random() * 46); // 5-50
    const amt = Math.max(10, Math.floor(pAmt / 5) + (Math.random() < 0.5 ? -diff : diff) / 2);
    botTotals[myBid.option] += Math.max(10, amt);
  }
  // 3 bots spread on other options, smaller realistic amounts.
  const others = OPTIONS.filter(o => o.id !== myBid.option);
  for (let i = 0; i < 3; i++) {
    const diff = 5 + Math.floor(Math.random() * 46); // 5-50
    const o = others[Math.floor(Math.random() * others.length)];
    botTotals[o.id] += Math.max(10, Math.floor(pAmt / 4) - diff / 3);
  }
}

// Refresh bots periodically
setInterval(() => {
  if (round && !document.hidden) {
    simulateDiceBots();
    renderOptions();
  }
}, 5000);

function renderMyBet() {
  $('d7-my-bet').textContent = myBid
    ? optById(myBid.option).emoji + ' ' + optById(myBid.option).name + ' · Rs ' + fmtRs(myBid.amount)
    : '—';
}

/* ---------------- data ---------------- */
async function fetchRound() {
  const { data, error } = await supabase.rpc('dice_get_current_round');
  if (error) throw error;
  return unwrapRow(data);
}

async function loadStats(roundId) {
  try {
    const { data } = await supabase.from('dice_round_stats')
      .select('*').eq('round_id', roundId).maybeSingle();
    const s = unwrapRow(data);
    if (s && (!round || s.round_id === round.id)) {
      const t = s.option_totals || {};
      OPTIONS.forEach(o => { optTotals[o.id] = Number(t[o.id] || 0); });
      renderOptions();
    }
  } catch (e) { console.warn('dice_round_stats read failed', e); }
}

async function loadMyBid(roundId) {
  try {
    const { data } = await supabase.from('dice_bids')
      .select('*').eq('round_id', roundId).eq('user_id', userId).maybeSingle();
    myBid = unwrapRow(data);
  } catch (e) { console.warn('dice my bid read failed', e); myBid = null; }
  renderMyBet();
  simulateDiceBots();
  renderOptions();
}

async function loadHistory() {
  const list = $('d7-history');
  try {
    const { data } = await supabase.from('public_dice_rounds')
      .select('round_no, winning_option, dice_total')
      .eq('status', 'closed')
      .order('starts_at', { ascending: false })
      .limit(10);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      list.innerHTML = '<p class="muted center">No rounds yet 🎲</p>';
      return;
    }
    list.innerHTML = '';
    rows.forEach(r => {
      const chip = document.createElement('span');
      const o = optById(r.winning_option);
      chip.className = 'flip-chip ' + (o ? 'won' : 'lost');
      chip.textContent = o ? o.emoji + ' ' + (r.dice_total ?? '') : '–';
      chip.title = 'Round #' + r.round_no + (o ? ' · ' + o.name + ' won' : ' · cancelled');
      list.appendChild(chip);
    });
  } catch (e) { console.warn('dice history failed', e); }
}

/* ---------------- round lifecycle ---------------- */
function onNewRound(r) {
  round = r;
  myBid = null;
  resultShownFor = null;
  choice = null;
  $('d7-result').hidden = true;
  $('d7-round-no').textContent = '#' + (r.round_no ?? '–');
  setDice(0, 0);
  const t = r.option_totals || {};
  OPTIONS.forEach(o => { optTotals[o.id] = Number(t[o.id] || 0); });
  simulateDiceBots();
  renderOptions();
  renderMyBet();
  $('btn-d7-bet').disabled = false;
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
    const { data } = await supabase.from('public_dice_rounds')
      .select('*').eq('id', closedRoundId).maybeSingle();
    fin = unwrapRow(data);
  } catch (e) { console.warn('dice final round read failed', e); }

  const winningOpt = fin?.winning_option || null;
  const t = fin?.option_totals || {};
  OPTIONS.forEach(o => { optTotals[o.id] = Number(t[o.id] || 0); });

  // Re-read my bid row — after settlement it carries is_winner/payout/refunded.
  await loadMyBid(closedRoundId);

  // Zero display bots for the settled round — show final real totals only.
  OPTIONS.forEach(o => { botTotals[o.id] = 0; });
  renderOptions();

  // Refresh wallet FIRST so the balance shown is current.
  try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }

  // Roll the dice to the final values (display-only, matches winning option).
  await rollDiceTo(fin?.dice1 || 1, fin?.dice2 || 1);

  const wo = optById(winningOpt);
  if (!myBid) {
    // Spectator: nothing personal to show.
  } else if (myBid.refunded) {
    setResult('⚠️ Round cancelled — your bet of Rs ' + fmtRs(myBid.amount) + ' was refunded.', false);
  } else if (myBid.is_winner) {
    sounds.win();
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    try { recordMissionEvent('win'); } catch (e) {}
    addNotification({ title: '🎉 You Won!', body: '+Rs ' + fmtRs(myBid.payout) + ' added to wallet', icon: '🎉', type: 'win' });
    // Effective multiplier from the real payout (approved 2x/5x; proportional when pool is small)
    const dAmt = Number(myBid.amount) || 0;
    const dPay = Number(myBid.payout) || 0;
    const dEff = dAmt > 0 ? dPay / dAmt : 0;
    const dMult = Math.abs(dEff - 2) < 0.06 ? '2x' : Math.abs(dEff - 5) < 0.06 ? '5x' : dEff.toFixed(1) + 'x';
    setResult(
      '🎉 <strong>' + (wo ? wo.emoji + ' ' + wo.name : '') + ' WINS!</strong> ' +
      '<strong style="color:#22c55e">+Rs ' + fmtRs(dPay) + '</strong> added to wallet! (' + dMult + ')',
      true
    );
  } else {
    sounds.lose();
    if (navigator.vibrate) navigator.vibrate(150);
    addNotification({ title: '😭 You Lost', body: '-Rs ' + fmtRs(myBid.amount) + ' deducted from wallet', icon: '😭', type: 'loss' });
    setResult(
      '😞 <strong>' + (wo ? wo.emoji + ' ' + wo.name : '') + '</strong> had the lowest total. ' +
      '<strong style="color:#ef4444">-Rs ' + fmtRs(myBid.amount) + '</strong> deducted from wallet.',
      false
    );
  }

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
      const t = r.option_totals || {};
      OPTIONS.forEach(o => { optTotals[o.id] = Number(t[o.id] || 0); });
      renderOptions();
    }
  } catch (e) { console.warn('dice sync failed', e); }
}

function tickClock() {
  if (!round?.ends_at) { $('d7-clock-time').textContent = '--:--'; return; }
  const ms = new Date(round.ends_at).getTime() - Date.now();
  const s = Math.max(0, Math.ceil(ms / 1000));
  $('d7-clock-time').textContent =
    String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/* ---------------- betting ---------------- */
async function placeBet() {
  if (placing) return;
  unlockAudio();
  if (!round?.id) { toast('Round is loading — wait a second…', true); return; }
  if (!choice) { toast('Pick an option first! 🎲', true); return; }
  // Same rule as all games: min 3 real players
  try {
    const { data: bidRows } = await supabase.from('dice_bids').select('user_id').eq('round_id', round.id);
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
  $('btn-d7-bet').disabled = true;
  try {
    const { data, error } = await supabase.rpc('dice_place_bid', {
      p_round_id: round.id, p_option: choice, p_amount: amount,
    });
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || row.ok === false) {
      // Loss cool-down BLOCK (15 straight losses): strong error toast.
      if (row?.error === 'cooldown' && row?.message) {
        toast(row.message, true);
        $('btn-d7-bet').disabled = false;
        return;
      }
      throw new Error(row?.error || 'Bet rejected');
    }
    // Loss streak WARNING (10+ straight losses): gentle non-blocking toast.
    if (row.warning) toast(row.warning);
    sounds.click();
    toast('⚡ Rs ' + fmtRs(amount) + ' on ' + optById(choice).name + '!');
    await loadMyBid(round.id);
    await loadStats(round.id);
    try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }
    try { recordMissionEvent('bid', { amount }); } catch (e) {}
  } catch (e) {
    toast(friendlyError(e, 'Bet failed. Try again.'), true);
    if (!myBid) $('btn-d7-bet').disabled = false;
  } finally {
    placing = false;
  }
}

/* ---------------- init ---------------- */
export function initDice() {
  try { refreshWallet().catch(() => {}); } catch (e) {}
  setDice(0, 0);
  renderOptions();

  $$('#d7-tabs .bid-tab').forEach(t => t.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('#d7-tabs .bid-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('d7-custom-row').hidden = t.dataset.amount !== 'custom';
  }));

  $('btn-d7-bet').addEventListener('click', placeBet);

  // Game-side sound toggle (synced with Member Center setting)
  const updateD7SoundBtn = () => {
    const btn = $('btn-sound-d7');
    if (btn) btn.textContent = isSoundOn() ? '🔊' : '🔇';
  };
  const soundBtn = $('btn-sound-d7');
  if (soundBtn) soundBtn.addEventListener('click', () => {
    unlockAudio();
    setSoundOn(!isSoundOn());
    updateD7SoundBtn();
    toast(isSoundOn() ? 'Sound on 🔊' : 'Sound off 🔇');
  });
  updateD7SoundBtn();

  clearInterval(syncTimer);
  clearInterval(clockTimer);
  sync();
  syncTimer = setInterval(sync, 3000);
  clockTimer = setInterval(tickClock, 500);
  loadHistory();
}
