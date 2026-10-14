/* ============================================================
   CASH VAULT — multiplayer money wheel, 15-second rounds.
   - cv_get_current_round() -> open round (15s, daily round_no reset)
   - Live segment totals via cv_round_stats (polled)
   - cv_place_bid(p_round_id, p_segment, p_amount) -> bet on a segment
   - Settlement (server-side cv_resolve_round):
       lowest-total segment WINS; winners get 1.9x from the losers' pool;
       the remainder is the hidden company fee.
       Single segment with all bids -> everyone loses (money to company).
       Fewer than 3 bids -> round cancelled, bids refunded.
   - Personal result: own cv_bids row (is_winner / payout / refunded).
   - The vault wheel spins and lands on the winning segment at settlement.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, unlockAudio, sounds, isSoundOn, setSoundOn } from './util.js';
import { refreshWallet } from './wallet.js';
import { recordMissionEvent } from './missions.js';
import { addNotification } from './notifications.js';

// 6 vault segments (order = wheel order, clockwise from top).
const SEGMENTS = [
  { id: 'red',    emoji: '🔴', name: 'RUBY',     color: '#e11d48' },
  { id: 'blue',   emoji: '🔵', name: 'SAPPHIRE', color: '#2563eb' },
  { id: 'gold',   emoji: '🟡', name: 'GOLD',     color: '#d4af37' },
  { id: 'green',  emoji: '🟢', name: 'EMERALD',  color: '#16a34a' },
  { id: 'purple', emoji: '🟪', name: 'AMETHYST', color: '#9333ea' },
  { id: 'silver', emoji: '⚪', name: 'DIAMOND',  color: '#94a3b8' },
];

let userId = null;
let round = null;            // current open round row
let choice = null;           // selected segment id
let myBid = null;            // my cv_bids row this round
let syncTimer = null;
let clockTimer = null;
let resultShownFor = null;   // round id we already settled in UI
let spinTotal = 0;           // cumulative wheel rotate degrees
let placing = false;
let segTotals = {};          // real totals per segment (from stats)
let botTotals = {};          // display-only bot totals per segment

export function setUser(id) { userId = id; }

export function destroyCashvault() {
  clearInterval(syncTimer); syncTimer = null;
  clearInterval(clockTimer); clockTimer = null;
  round = null; myBid = null; resultShownFor = null;
}

/* ---------------- helpers ---------------- */
function currentAmount() {
  const active = document.querySelector('#cv-tabs .bid-tab.active');
  if (!active) return 10;
  if (active.dataset.amount === 'custom') {
    return Number($('cv-custom-input').value) || 0;
  }
  return Number(active.dataset.amount) || 0;
}

function setResult(html, won) {
  const el = $('cv-result');
  el.innerHTML = html;
  el.className = 'cf-result ' + (won ? 'win' : 'lose');
  el.hidden = false;
}

function segById(id) { return SEGMENTS.find(s => s.id === id); }

function renderSegments() {
  const grid = $('cv-segments');
  grid.innerHTML = '';
  SEGMENTS.forEach(s => {
    const real = Number(segTotals[s.id] || 0);
    const bots = Number(botTotals[s.id] || 0);
    const btn = document.createElement('button');
    btn.className = 'cv-seg-btn' + (choice === s.id ? ' selected' : '');
    btn.dataset.seg = s.id;
    btn.innerHTML =
      '<span class="cv-seg-emoji">' + s.emoji + '</span>' +
      '<span class="cv-seg-name">' + s.name + '</span>' +
      '<span class="cv-seg-total">Rs ' + fmtRs(real + bots) + '</span>';
    btn.addEventListener('click', () => {
      unlockAudio(); sounds.click();
      choice = s.id;
      $$('#cv-segments .cv-seg-btn').forEach(x => x.classList.remove('selected'));
      btn.classList.add('selected');
    });
    grid.appendChild(btn);
  });
}

function renderTotals() {
  renderSegments();
}

/* BOT SIMULATION (display-only): Simple rule, same as other games.
   - Player bets on Segment A.
   - Bots put MORE on Segment A (same segment as player).
   - Bots put LESS on the other segments.
   - Lowest segment wins -> player loses.
   - Bot amounts stay realistic: within 5-50 Rs of the player's bid.
*/
function simulateCashVaultBots() {
  SEGMENTS.forEach(s => { botTotals[s.id] = 0; });

  if (!myBid) {
    // No player: 8 random bots spread across segments.
    for (let i = 0; i < 8; i++) {
      const amt = 10 + Math.floor(Math.random() * 200);
      const s = SEGMENTS[Math.floor(Math.random() * SEGMENTS.length)];
      botTotals[s.id] += amt;
    }
    return;
  }

  const pAmt = Number(myBid.amount || 100);
  // 5 bots on the player's segment: amounts near the player's bid (5-50 Rs diff).
  for (let i = 0; i < 5; i++) {
    const diff = 5 + Math.floor(Math.random() * 46); // 5-50
    const amt = Math.max(10, Math.floor(pAmt / 5) + (Math.random() < 0.5 ? -diff : diff) / 2);
    botTotals[myBid.segment] += Math.max(10, amt);
  }
  // 3 bots spread on other segments, smaller realistic amounts.
  const others = SEGMENTS.filter(s => s.id !== myBid.segment);
  for (let i = 0; i < 3; i++) {
    const diff = 5 + Math.floor(Math.random() * 46); // 5-50
    const s = others[Math.floor(Math.random() * others.length)];
    botTotals[s.id] += Math.max(10, Math.floor(pAmt / 4) - diff / 3);
  }
}

// Refresh bots periodically
setInterval(() => {
  if (round && !document.hidden) {
    simulateCashVaultBots();
    renderTotals();
  }
}, 5000);

function renderMyBet() {
  $('cv-my-bet').textContent = myBid
    ? segById(myBid.segment).emoji + ' ' + segById(myBid.segment).name + ' · Rs ' + fmtRs(myBid.amount)
    : '—';
}

/* Spin the vault wheel so the pointer lands on segment `segId`. */
function spinWheelTo(segId) {
  const wheel = $('cv-wheel');
  if (!wheel) return Promise.resolve();
  const idx = SEGMENTS.findIndex(s => s.id === segId);
  if (idx < 0) return Promise.resolve();
  wheel.style.transition = 'none';
  wheel.style.transform = 'rotate(' + (spinTotal % 360) + 'deg)';
  void wheel.offsetWidth;
  wheel.style.transition = '';
  // Segment idx center sits at local angle idx*60 (clockwise from top).
  // Rotate wheel so that center lands on top: R ≡ -idx*60 (mod 360).
  const target = ((360 - idx * 60) % 360 + 360) % 360;
  const base = spinTotal + 1800; // 5 full spins
  const rem = ((base % 360) + 360) % 360;
  const adjust = (target - rem + 360) % 360;
  spinTotal = base + adjust;
  wheel.style.transform = 'rotate(' + spinTotal + 'deg)';
  return new Promise(r => setTimeout(r, 2500));
}

/* ---------------- data ---------------- */
async function fetchRound() {
  const { data, error } = await supabase.rpc('cv_get_current_round');
  if (error) throw error;
  return unwrapRow(data);
}

async function loadStats(roundId) {
  try {
    const { data } = await supabase.from('cv_round_stats')
      .select('*').eq('round_id', roundId).maybeSingle();
    const s = unwrapRow(data);
    if (s && (!round || s.round_id === round.id)) {
      const t = s.segment_totals || {};
      SEGMENTS.forEach(seg => { segTotals[seg.id] = Number(t[seg.id] || 0); });
      renderTotals();
    }
  } catch (e) { console.warn('cv_round_stats read failed', e); }
}

async function loadMyBid(roundId) {
  try {
    const { data } = await supabase.from('cv_bids')
      .select('*').eq('round_id', roundId).eq('user_id', userId).maybeSingle();
    myBid = unwrapRow(data);
  } catch (e) { console.warn('cv my bid read failed', e); myBid = null; }
  renderMyBet();
  simulateCashVaultBots();
  renderTotals();
}

async function loadHistory() {
  const list = $('cv-history');
  try {
    const { data } = await supabase.from('public_cv_rounds')
      .select('round_no, winning_segment')
      .eq('status', 'closed')
      .order('starts_at', { ascending: false })
      .limit(10);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      list.innerHTML = '<p class="muted center">No rounds yet 💰</p>';
      return;
    }
    list.innerHTML = '';
    rows.forEach(r => {
      const chip = document.createElement('span');
      const s = segById(r.winning_segment);
      chip.className = 'flip-chip ' + (s ? 'won' : 'lost');
      chip.textContent = s ? s.emoji + ' ' + s.name : '–';
      chip.title = 'Round #' + r.round_no + (s ? ' · ' + s.name + ' won' : ' · cancelled');
      list.appendChild(chip);
    });
  } catch (e) { console.warn('cv history failed', e); }
}

/* ---------------- round lifecycle ---------------- */
function onNewRound(r) {
  round = r;
  myBid = null;
  resultShownFor = null;
  choice = null;
  $('cv-result').hidden = true;
  $('cv-round-no').textContent = '#' + (r.round_no ?? '–');
  const t = r.seg_totals || {};
  SEGMENTS.forEach(s => { segTotals[s.id] = Number(t[s.id] || 0); });
  simulateCashVaultBots();
  renderTotals();
  renderMyBet();
  $('btn-cv-bet').disabled = false;
  loadMyBid(r.id);
  loadStats(r.id);
}

async function onSettled(closedRoundId) {
  if (resultShownFor === closedRoundId) return;
  resultShownFor = closedRoundId;
  $('btn-cv-bet').disabled = true;

  // Final authoritative state of the settled round.
  let fin = null;
  try {
    const { data } = await supabase.from('public_cv_rounds')
      .select('*').eq('id', closedRoundId).maybeSingle();
    fin = unwrapRow(data);
  } catch (e) { console.warn('cv final round read failed', e); }

  const winningSeg = fin?.winning_segment || null;
  const t = fin?.seg_totals || {};
  SEGMENTS.forEach(s => { segTotals[s.id] = Number(t[s.id] || 0); });

  // Re-read my bid row — after settlement it carries is_winner/payout/refunded.
  await loadMyBid(closedRoundId);

  // Zero display bots for the settled round — show final real totals only.
  SEGMENTS.forEach(s => { botTotals[s.id] = 0; });
  renderTotals();

  // Refresh wallet FIRST so the balance shown is current.
  try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }

  if (winningSeg) await spinWheelTo(winningSeg);

  const ws = segById(winningSeg);
  if (!myBid) {
    // Spectator: nothing personal to show.
  } else if (myBid.refunded) {
    setResult('⚠️ Round cancelled — your bet of Rs ' + fmtRs(myBid.amount) + ' was refunded.', false);
  } else if (myBid.is_winner) {
    sounds.win();
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    try { recordMissionEvent('win'); } catch (e) {}
    addNotification({ title: '🎉 You Won!', body: '+Rs ' + fmtRs(myBid.payout) + ' added to wallet', icon: '🎉', type: 'win' });
    setResult(
      '🎉 <strong>' + (ws ? ws.emoji + ' ' + ws.name : '') + ' WINS!</strong> ' +
      '<strong style="color:#22c55e">+Rs ' + fmtRs(myBid.payout) + '</strong> added to wallet! (1.9x)',
      true
    );
  } else {
    sounds.lose();
    if (navigator.vibrate) navigator.vibrate(150);
    addNotification({ title: '😭 You Lost', body: '-Rs ' + fmtRs(myBid.amount) + ' deducted from wallet', icon: '😭', type: 'loss' });
    setResult(
      '😞 <strong>' + (ws ? ws.emoji + ' ' + ws.name : '') + '</strong> had the lowest total. ' +
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
      const t = r.seg_totals || {};
      SEGMENTS.forEach(s => { segTotals[s.id] = Number(t[s.id] || 0); });
      renderTotals();
    }
  } catch (e) { console.warn('cv sync failed', e); }
}

function tickClock() {
  if (!round?.ends_at) { $('cv-clock-time').textContent = '--:--'; return; }
  const ms = new Date(round.ends_at).getTime() - Date.now();
  const s = Math.max(0, Math.ceil(ms / 1000));
  $('cv-clock-time').textContent =
    String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/* ---------------- betting ---------------- */
async function placeBet() {
  if (placing) return;
  unlockAudio();
  if (!round?.id) { toast('Round is loading — wait a second…', true); return; }
  if (!choice) { toast('Pick a vault segment first! 💰', true); return; }
  // Same rule as all games: min 3 real players
  try {
    const { data: bidRows } = await supabase.from('cv_bids').select('user_id').eq('round_id', round.id);
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
  $('btn-cv-bet').disabled = true;
  try {
    const { data, error } = await supabase.rpc('cv_place_bid', {
      p_round_id: round.id, p_segment: choice, p_amount: amount,
    });
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || row.ok === false) {
      // Loss cool-down BLOCK (15 straight losses): strong error toast.
      if (row?.error === 'cooldown' && row?.message) {
        toast(row.message, true);
        $('btn-cv-bet').disabled = false;
        return;
      }
      throw new Error(row?.error || 'Bet rejected');
    }
    // Loss streak WARNING (10+ straight losses): gentle non-blocking toast.
    if (row.warning) toast(row.warning);
    sounds.click();
    toast('⚡ Rs ' + fmtRs(amount) + ' on ' + segById(choice).name + '!');
    await loadMyBid(round.id);
    await loadStats(round.id);
    try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }
    try { recordMissionEvent('bid', { amount }); } catch (e) {}
  } catch (e) {
    toast(friendlyError(e, 'Bet failed. Try again.'), true);
    if (!myBid) $('btn-cv-bet').disabled = false;
  } finally {
    placing = false;
  }
}

/* ---------------- init ---------------- */
export function initCashvault() {
  // Build wheel labels (rotate with the wheel).
  const wheel = $('cv-wheel');
  SEGMENTS.forEach((s, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'cv-wheel-label';
    wrap.style.transform = 'rotate(' + (i * 60) + 'deg)';
    wrap.innerHTML = '<span>' + s.emoji + '</span>';
    wheel.appendChild(wrap);
  });

  renderSegments();

  $$('#cv-tabs .bid-tab').forEach(t => t.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('#cv-tabs .bid-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('cv-custom-row').hidden = t.dataset.amount !== 'custom';
  }));

  $('btn-cv-bet').addEventListener('click', placeBet);

  // Game-side sound toggle (synced with Member Center setting)
  const updateCvSoundBtn = () => {
    const btn = $('btn-sound-cv');
    if (btn) btn.textContent = isSoundOn() ? '🔊' : '🔇';
  };
  const soundBtn = $('btn-sound-cv');
  if (soundBtn) soundBtn.addEventListener('click', () => {
    unlockAudio();
    setSoundOn(!isSoundOn());
    updateCvSoundBtn();
    toast(isSoundOn() ? 'Sound on 🔊' : 'Sound off 🔇');
  });
  updateCvSoundBtn();

  clearInterval(syncTimer);
  clearInterval(clockTimer);
  sync();
  syncTimer = setInterval(sync, 3000);
  clockTimer = setInterval(tickClock, 500);
  loadHistory();
}
