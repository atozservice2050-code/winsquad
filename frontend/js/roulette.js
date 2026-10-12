/* ============================================================
   ROULETTE — American Roulette, multiplayer, 30-second rounds.
   - roulette_get_current_round() -> open round (30s, daily round_no reset)
   - Live totals via roulette_round_stats (polled)
   - roulette_place_bets(p_round_id, p_bets jsonb) -> batch chip placement
   - Settlement (server-side roulette_resolve_round):
       winning number is drawn SERVER-SIDE (house-controlled);
       winners paid by odds (straight 35:1, dozens 2:1, even-money 1:1);
       the remainder of the pool is the hidden company fee.
   - Personal result: own roulette_bids rows (is_winner / payout).
   - The wheel spins and the ball lands on the backend's number.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, unlockAudio, sounds } from './util.js';
import { refreshWallet } from './wallet.js';
import { recordMissionEvent } from './missions.js';

/* American wheel order (clockwise). */
const RL_WHEEL_ORDER = ['0','28','9','26','30','11','7','20','32','17','5','22',
  '34','15','3','24','36','13','1','00','27','10','25','29','12','8','19','31',
  '18','6','21','33','16','4','23','35','14','2'];
const RL_RED = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

const RL_NUMBERS = [];
for (let n = 1; n <= 36; n++) RL_NUMBERS.push(String(n));

function rlColor(n) {
  if (n === '0' || n === '00') return 'green';
  return RL_RED.includes(Number(n)) ? 'red' : 'black';
}

let userId = null;
let round = null;
let chipAmount = 10;
let pending = [];            // [{bet_type, bet_value, amount}]
let myBids = [];             // placed roulette_bids rows this round
let syncTimer = null;
let clockTimer = null;
let botTimer = null;
let resultShownFor = null;
let wheelDeg = 0;
let placing = false;
let settling = false;

export function setUser(id) { userId = id; }

export function destroyRoulette() {
  clearInterval(syncTimer); syncTimer = null;
  clearInterval(clockTimer); clockTimer = null;
  clearInterval(botTimer); botTimer = null;
  round = null; myBids = []; pending = []; resultShownFor = null; settling = false;
}

/* ---------------- chips & pending bets ---------------- */
function pendingKey(b) { return b.bet_type + ':' + b.bet_value; }

function addPending(betType, betValue) {
  const amt = chipAmount;
  if (!amt || amt < 10) { toast('Pick a chip first (min Rs 10).', true); return; }
  const key = betType + ':' + betValue;
  const ex = pending.find(b => pendingKey(b) === key);
  if (ex) ex.amount = Math.round((ex.amount + amt) * 100) / 100;
  else pending.push({ bet_type: betType, bet_value: betValue, amount: amt });
  sounds.click();
  renderPending();
}

function pendingTotal() {
  return pending.reduce((s, b) => s + b.amount, 0);
}

function bettingOpen() {
  if (settling || !round?.ends_at) return !settling;
  const s = Math.ceil((new Date(round.ends_at).getTime() - Date.now()) / 1000);
  return s > 3;
}

function renderPending() {
  // chip badges on table cells
  $$('#rl-table .rl-cell').forEach(cell => {
    const key = cell.dataset.bet;
    const amt = pending.filter(b => pendingKey(b) === key)
                       .reduce((s, b) => s + b.amount, 0);
    let badge = cell.querySelector('.rl-chipbadge');
    if (amt > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'rl-chipbadge';
        cell.appendChild(badge);
      }
      badge.textContent = fmtRs(amt);
    } else if (badge) {
      badge.remove();
    }
  });
  $('rl-pending-total').textContent = 'Rs ' + fmtRs(pendingTotal());
  $('btn-rl-bet').disabled = pending.length === 0 || !bettingOpen();
}

/* ---------------- betting table ---------------- */
function cellBtn(label, betType, betValue, extraClass) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rl-cell ' + (extraClass || '');
  b.dataset.bet = betType + ':' + betValue;
  b.innerHTML = '<span>' + label + '</span>';
  b.addEventListener('click', () => { unlockAudio(); addPending(betType, betValue); });
  return b;
}

function buildTable() {
  const t = $('rl-table');
  t.innerHTML = '';

  // 0 / 00 row
  const zeroRow = document.createElement('div');
  zeroRow.className = 'rl-zero-row';
  zeroRow.appendChild(cellBtn('0', 'straight', '0', 'rl-green'));
  zeroRow.appendChild(cellBtn('00', 'straight', '00', 'rl-green'));
  t.appendChild(zeroRow);

  // numbers 1-36 in 3 columns (rows of 3, like the real layout)
  const grid = document.createElement('div');
  grid.className = 'rl-num-grid';
  // Real table order per row: 3,2,1 / 6,5,4 ... (3n, 3n-1, 3n-2)
  for (let row = 0; row < 12; row++) {
    [3, 2, 1].forEach(col => {
      const n = String(row * 3 + col);
      grid.appendChild(cellBtn(n, 'straight', n, 'rl-' + rlColor(n)));
    });
  }
  t.appendChild(grid);

  // dozens
  const dozens = document.createElement('div');
  dozens.className = 'rl-outside-row';
  [['1st 12', 'dozen1', ''], ['2nd 12', 'dozen2', ''], ['3rd 12', 'dozen3', '']]
    .forEach(([label, type, val]) =>
      dozens.appendChild(cellBtn(label, type, val, 'rl-outside')));
  t.appendChild(dozens);

  // even-money bets
  const outside = document.createElement('div');
  outside.className = 'rl-outside-row rl-six';
  outside.appendChild(cellBtn('1–18', 'low', '', 'rl-outside'));
  outside.appendChild(cellBtn('EVEN', 'even', '', 'rl-outside'));
  const redD = cellBtn('◆', 'red', '', 'rl-outside rl-diamond-red');
  const blkD = cellBtn('◆', 'black', '', 'rl-outside rl-diamond-black');
  outside.appendChild(redD);
  outside.appendChild(blkD);
  outside.appendChild(cellBtn('ODD', 'odd', '', 'rl-outside'));
  outside.appendChild(cellBtn('19–36', 'high', '', 'rl-outside'));
  t.appendChild(outside);
}

/* ---------------- wheel ---------------- */
function buildWheel() {
  const holder = $('rl-wheel');
  if (!holder || holder.dataset.built) return;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('class', 'rl-svg');

  // wooden rim
  const rim = document.createElementNS(NS, 'circle');
  rim.setAttribute('cx', 100); rim.setAttribute('cy', 100); rim.setAttribute('r', 98);
  rim.setAttribute('class', 'rl-rim');
  svg.appendChild(rim);
  const rim2 = document.createElementNS(NS, 'circle');
  rim2.setAttribute('cx', 100); rim2.setAttribute('cy', 100); rim2.setAttribute('r', 90);
  rim2.setAttribute('class', 'rl-rim-inner');
  svg.appendChild(rim2);

  // rotating number ring
  const ring = document.createElementNS(NS, 'g');
  ring.setAttribute('id', 'rl-wheel-ring');
  const seg = 360 / RL_WHEEL_ORDER.length;
  const R1 = 88, R0 = 58;
  const rad = d => d * Math.PI / 180;
  const pt = (r, deg) => [100 + r * Math.cos(rad(deg)), 100 + r * Math.sin(rad(deg))];

  RL_WHEEL_ORDER.forEach((num, i) => {
    const c = i * seg - 90; // center angle, 0 deg = top
    const a0 = c - seg / 2, a1 = c + seg / 2;
    const [x0, y0] = pt(R1, a0), [x1, y1] = pt(R1, a1);
    const [x2, y2] = pt(R0, a1), [x3, y3] = pt(R0, a0);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d',
      `M ${x0.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)} ` +
      `A ${R1} ${R1} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} ` +
      `L ${x3.toFixed(2)} ${y3.toFixed(2)} ` +
      `A ${R0} ${R0} 0 0 0 ${x0.toFixed(2)} ${y0.toFixed(2)} Z`);
    p.setAttribute('class', 'rl-wedge rl-w-' + rlColor(num));
    ring.appendChild(p);

    const [tx, ty] = pt((R0 + R1) / 2, c);
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', tx.toFixed(2)); label.setAttribute('y', ty.toFixed(2));
    label.setAttribute('class', 'rl-wedge-label');
    label.setAttribute('transform', `rotate(${(c + 90).toFixed(2)} ${tx.toFixed(2)} ${ty.toFixed(2)})`);
    label.textContent = num;
    ring.appendChild(label);
  });
  svg.appendChild(ring);

  // static center turret
  const hub = document.createElementNS(NS, 'circle');
  hub.setAttribute('cx', 100); hub.setAttribute('cy', 100); hub.setAttribute('r', 56);
  hub.setAttribute('class', 'rl-hub');
  svg.appendChild(hub);
  const cross1 = document.createElementNS(NS, 'rect');
  cross1.setAttribute('x', 97); cross1.setAttribute('y', 52);
  cross1.setAttribute('width', 6); cross1.setAttribute('height', 96);
  cross1.setAttribute('class', 'rl-turret');
  svg.appendChild(cross1);
  const cross2 = document.createElementNS(NS, 'rect');
  cross2.setAttribute('x', 52); cross2.setAttribute('y', 97);
  cross2.setAttribute('width', 96); cross2.setAttribute('height', 6);
  cross2.setAttribute('class', 'rl-turret');
  svg.appendChild(cross2);
  const knob = document.createElementNS(NS, 'circle');
  knob.setAttribute('cx', 100); knob.setAttribute('cy', 100); knob.setAttribute('r', 10);
  knob.setAttribute('class', 'rl-knob');
  svg.appendChild(knob);

  holder.appendChild(svg);
  holder.dataset.built = '1';
}

/* Spin the wheel so `number` lands at the top (ball position). */
function spinWheelTo(number) {
  const seg = 360 / RL_WHEEL_ORDER.length;
  const idx = RL_WHEEL_ORDER.indexOf(String(number));
  const k = idx < 0 ? 0 : idx;
  const targetMod = (((-k * seg) % 360) + 360) % 360;
  const cur = (((wheelDeg % 360) + 360) % 360);
  const delta = (((targetMod - cur) % 360) + 360) % 360;
  wheelDeg += 360 * 6 + delta;
  const ring = document.getElementById('rl-wheel-ring');
  if (ring) {
    ring.style.transition = 'transform 4.6s cubic-bezier(0.12, 0.75, 0.16, 1)';
    ring.style.transform = `rotate(${wheelDeg}deg)`;
  }
  return new Promise(r => setTimeout(r, 4800));
}

function ballOrbit(on) {
  const o = $('rl-ball-orbit');
  if (!o) return;
  o.classList.toggle('orbiting', on);
  o.classList.toggle('settled', !on);
}

/* ---------------- data ---------------- */
async function fetchRound() {
  const { data, error } = await supabase.rpc('roulette_get_current_round');
  if (error) throw error;
  return unwrapRow(data);
}

async function loadStats(roundId) {
  try {
    const { data } = await supabase.from('roulette_round_stats')
      .select('*').eq('round_id', roundId).maybeSingle();
    const s = unwrapRow(data);
    if (s && (!round || s.round_id === round.id)) {
      $('rl-total-bet').textContent = fmtRs(Number(s.total_bet || 0));
      $('rl-players').dataset.real = s.player_count || 0;
      renderPlayers();
    }
  } catch (e) { console.warn('roulette stats read failed', e); }
}

async function loadMyBids(roundId) {
  try {
    const { data } = await supabase.from('roulette_bids')
      .select('*').eq('round_id', roundId).eq('user_id', userId)
      .order('placed_at', { ascending: true });
    myBids = Array.isArray(data) ? data : [];
  } catch (e) { console.warn('roulette my bids read failed', e); myBids = []; }
  renderMyBets();
}

function betLabel(b) {
  if (b.bet_type === 'straight') return '#' + b.bet_value;
  const names = { red: '🔴 Red', black: '⚫ Black', odd: 'Odd', even: 'Even',
    low: '1–18', high: '19–36', dozen1: '1st 12', dozen2: '2nd 12', dozen3: '3rd 12' };
  return names[b.bet_type] || b.bet_type;
}

function renderMyBets() {
  const el = $('rl-my-bets');
  if (!myBids.length) { el.textContent = '—'; return; }
  const total = myBids.reduce((s, b) => s + Number(b.amount || 0), 0);
  el.textContent = myBids.length + ' bet' + (myBids.length > 1 ? 's' : '') +
    ' · Rs ' + fmtRs(total) + ' (' +
    myBids.map(b => betLabel(b)).join(', ') + ')';
}

async function loadHistory() {
  const list = $('rl-history');
  try {
    const { data } = await supabase.from('public_roulette_rounds')
      .select('round_no, winning_number')
      .eq('status', 'closed')
      .order('starts_at', { ascending: false })
      .limit(12);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      list.innerHTML = '<p class="muted center">No rounds yet 🎡</p>';
      return;
    }
    list.innerHTML = '';
    rows.forEach(r => {
      const chip = document.createElement('span');
      chip.className = 'rl-hist rl-' + rlColor(r.winning_number);
      chip.textContent = r.winning_number;
      chip.title = 'Round #' + r.round_no;
      list.appendChild(chip);
    });
  } catch (e) { console.warn('roulette history failed', e); }
}

/* ---------------- bots (display only) ---------------- */
const BOT_NAMES = ['Ahmed', 'Bilal', 'Usman', 'Ali', 'Hassan', 'Fahad', 'Imran',
  'Kamran', 'Danish', 'Saqib', 'Waqas', 'Adnan', 'Tariq', 'Nadeem', 'Asif'];
const BOT_SPOTS = ['🔴 Red', '⚫ Black', 'Odd', 'Even', '1st 12', '#7', '#23', '#17', '#32'];
let botCount = 0;

function renderPlayers() {
  const real = Number($('rl-players').dataset.real || 0);
  $('rl-players').textContent = real + botCount;
}

function refreshBots() {
  if (!round || document.hidden || settling) return;
  botCount = 6 + Math.floor(Math.random() * 14);
  renderPlayers();
  const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  const spot = BOT_SPOTS[Math.floor(Math.random() * BOT_SPOTS.length)];
  const amt = [10, 50, 100, 250][Math.floor(Math.random() * 4)];
  $('rl-ticker').textContent = `🟢 ${name} bet Rs ${fmtRs(amt)} on ${spot}`;
}

/* ---------------- round lifecycle ---------------- */
function onNewRound(r) {
  round = r;
  myBids = [];
  pending = [];
  settling = false;
  resultShownFor = null;
  $('rl-round-no').textContent = '#' + (r.round_no ?? '–');
  $('rl-total-bet').textContent = fmtRs(Number(r.total_bet || 0));
  $('rl-players').dataset.real = r.player_count || 0;
  $('rl-result').hidden = true;
  ballOrbit(true);
  renderPending();
  renderMyBets();
  $('btn-rl-bet').disabled = true;
  loadMyBids(r.id);
  loadStats(r.id);
  refreshBots();
}

function setResult(html, won) {
  const el = $('rl-result');
  el.innerHTML = html;
  el.className = 'rl-result ' + (won ? 'win' : 'lose');
  el.hidden = false;
}

async function onSettled(closedRoundId) {
  if (resultShownFor === closedRoundId) return;
  resultShownFor = closedRoundId;
  settling = true;
  $('btn-rl-bet').disabled = true;
  ballOrbit(false);

  // Final authoritative state of the settled round.
  let fin = null;
  try {
    const { data } = await supabase.from('public_roulette_rounds')
      .select('*').eq('id', closedRoundId).maybeSingle();
    fin = unwrapRow(data);
  } catch (e) { console.warn('roulette final round read failed', e); }

  const winNum = fin?.winning_number ?? null;
  $('rl-total-bet').textContent = fmtRs(Number(fin?.total_bet || 0));

  // Re-read my bids — after settlement they carry is_winner/payout.
  await loadMyBids(closedRoundId);

  // Spin the wheel; the ball lands on the backend's number.
  if (winNum !== null) {
    sounds.click();
    await spinWheelTo(winNum);
  }

  const bet = myBids.reduce((s, b) => s + Number(b.amount || 0), 0);
  const won = myBids.filter(b => b.is_winner)
                    .reduce((s, b) => s + Number(b.payout || 0), 0);

  if (!myBids.length) {
    setResult('🎡 Ball landed on <strong class="rl-' + rlColor(winNum) + '">' +
      winNum + '</strong>. Place your bets next round!', false);
  } else if (won > 0) {
    sounds.win();
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    try { recordMissionEvent('win'); } catch (e) {}
    const profit = won - bet;
    setResult('🎉 Ball landed on <strong>' + winNum + '</strong>! ' +
      'You won <strong class="green">Rs ' + fmtRs(won) + '</strong>' +
      (profit > 0 ? ' (+Rs ' + fmtRs(profit) + ' profit)!' : '!'), true);
  } else {
    sounds.lose();
    if (navigator.vibrate) navigator.vibrate(150);
    setResult('😞 Ball landed on <strong>' + winNum + '</strong>. ' +
      'Lost Rs ' + fmtRs(bet) + ' — better luck next round!', false);
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
      if (prevId && prevId !== r.id) onSettled(prevId);
    } else {
      $('rl-total-bet').textContent = fmtRs(Number(r.total_bet || 0));
    }
  } catch (e) { console.warn('roulette sync failed', e); }
}

function tickClock() {
  if (!round?.ends_at) { $('rl-clock-time').textContent = '--:--'; return; }
  const ms = new Date(round.ends_at).getTime() - Date.now();
  const s = Math.max(0, Math.ceil(ms / 1000));
  $('rl-clock-time').textContent =
    String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  // Betting closes in the last 3 seconds (backend enforces too).
  $('btn-rl-bet').disabled = pending.length === 0 || !bettingOpen();
}

/* ---------------- betting ---------------- */
async function placeBets() {
  if (placing || settling) return;
  unlockAudio();
  if (!round?.id) { toast('Round is loading — wait a second…', true); return; }
  if (!pending.length) { toast('Tap the table to place chips first! 🎡', true); return; }

  placing = true;
  $('btn-rl-bet').disabled = true;
  const total = pendingTotal();
  try {
    const { data, error } = await supabase.rpc('roulette_place_bets', {
      p_round_id: round.id, p_bets: pending,
    });
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || row.ok === false) throw new Error(row?.error || 'Bets rejected');
    sounds.click();
    toast('⚡ ' + row.bets + ' bet' + (row.bets > 1 ? 's' : '') +
      ' placed · Rs ' + fmtRs(row.total) + '!');
    pending = [];
    renderPending();
    await loadMyBids(round.id);
    await loadStats(round.id);
    try { await refreshWallet(); } catch (e) { console.warn('wallet refresh failed', e); }
    try { recordMissionEvent('bid', { amount: total }); } catch (e) {}
  } catch (e) {
    toast(friendlyError(e, 'Bets failed. Try again.'), true);
    renderPending();
  } finally {
    placing = false;
  }
}

/* ---------------- init ---------------- */
export function initRoulette() {
  buildWheel();
  buildTable();

  $$('#rl-chips .rl-chip').forEach(t => t.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('#rl-chips .rl-chip').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    if (t.dataset.amount === 'custom') {
      $('rl-custom-row').hidden = false;
      const v = Number($('rl-custom-input').value) || 0;
      chipAmount = v >= 10 ? v : 0;
    } else {
      $('rl-custom-row').hidden = true;
      chipAmount = Number(t.dataset.amount) || 10;
    }
  }));
  $('rl-custom-input').addEventListener('input', () => {
    const v = Number($('rl-custom-input').value) || 0;
    chipAmount = v >= 10 ? v : 0;
  });

  $('btn-rl-bet').addEventListener('click', placeBets);
  $('btn-rl-clear').addEventListener('click', () => {
    unlockAudio(); sounds.click();
    pending = [];
    renderPending();
  });

  clearInterval(syncTimer);
  clearInterval(clockTimer);
  clearInterval(botTimer);
  sync();
  syncTimer = setInterval(sync, 3000);
  clockTimer = setInterval(tickClock, 500);
  botTimer = setInterval(refreshBots, 6000);
  loadHistory();
}
