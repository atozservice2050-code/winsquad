/* ============================================================
   PRIVATE TABLES — 4 seats, invite code, bids Rs 50 to Rs 10,000.
   - create_private_table() -> {table_id, code}
   - join_private_table(p_code) -> {ok, error, table_id}
   - place_private_bid(p_table_id, p_amount)
   - spin_private_table(p_table_id) -> resolves the round (manual spin)
   - leave_private_table(p_table_id) -> {ok, seats_left, status}
   - Reads: private_tables / private_seats / private_bids for
     tables the user sits at (realtime subscribed).
   Rules reflected: clock starts on FIRST bid (30s); only the 1
   highest bidder loses; total reveals after ALL seated players
   have bid. A table starts with 2 players seated (4 max).
   Column names below are best-effort guesses against the backend
   contract — every read is defensive (see README "Backend contract").
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, sounds, unlockAudio, copyText } from './util.js';

let table = null;          // private_tables row
let seats = [];            // private_seats rows
let bids = [];             // private_bids rows (current round)
let selectedBid = 100;
let clockInt = null;
let channels = [];
let pollInt = null;          // 1s safety refresh while seated (realtime stays primary)
let leaveArmed = false;
let leaveArmTimer = null;
let userId = null;
let myName = 'You';
let currentCode = '';
let joiningPrivate = false;
let seatNames = {};          // user_id -> display_name (from public_profiles)
let knownBidIds = new Set(); // bids already seen (chip fly-in animation)
let stagePrimed = false;     // skip fly-in for bids that predate entering
let lastRoundSeen = null;    // current_round_no at last render (resolve detect)
let resultPoppedFor = 0;     // highest round no. already shown as a pop-up
let highlightMap = {};       // user_id -> 'win' | 'lose' after a resolve
let highlightUntil = 0;      // highlight expiry timestamp (ms)
let arrowDeg = 0;            // accumulated needle rotation (spins keep going forward)
let spinTimer = null;        // pending reveal after the 5s needle spin
let localSpinRound = null;   // round THIS client spun via the pot click
let spinInFlight = false;    // a pot-click spin is currently running
let curSpin = { ready: false, spinner: null }; // spin state at last render

export function setUser(id, displayName) { userId = id; myName = displayName || 'You'; }

function showError(msg) {
  const el = $('private-error');
  el.textContent = msg;
  el.hidden = false;
}
function hideError() { $('private-error').hidden = true; }

function normalizeInviteCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

function inviteLink(code = currentCode) {
  const clean = normalizeInviteCode(code);
  return location.origin + location.pathname + '?join=' + encodeURIComponent(clean);
}

async function shareInviteLink() {
  unlockAudio();
  const code = normalizeInviteCode(currentCode || table?.code || $('invite-code')?.textContent);
  if (!code || code === '------') { toast('Create or join a table first.', true); return; }
  const url = inviteLink(code);
  const shareData = {
    title: 'WinSquad Private Table',
    text: 'Join my WinSquad private table (code ' + code + '):',
    url,
  };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch (e) { if (e?.name === 'AbortError') return; }
  }
  await copyText(url, 'Invite link copied!');
}

async function copyInviteLink() {
  const code = normalizeInviteCode(currentCode || table?.code || $('invite-code')?.textContent);
  if (!code || code === '------') { toast('Create or join a table first.', true); return; }
  await copyText(inviteLink(code), 'Invite link copied!');
}

/* ---------------- lobby: create / join ---------------- */
async function createTable() {
  unlockAudio(); hideError();
  $('btn-create-table').disabled = true;
  try {
    const { data, error } = await supabase.rpc('create_private_table');
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || !row.table_id) throw new Error('Could not create the table.');
    currentCode = normalizeInviteCode(row.code);
    $('invite-code').textContent = row.code || '------';
    $('invite-code-card').hidden = false;
    toast('Table created! Share your code 🔒');
    await enterTable(row.table_id, row.code);
  } catch (e) {
    showError(friendlyError(e, 'Could not create the table. Try again.'));
  } finally {
    $('btn-create-table').disabled = false;
  }
}

async function joinTableByCode(rawCode) {
  hideError();
  const code = normalizeInviteCode(rawCode);
  if (!code) { showError('Enter the invite code.'); return false; }
  if (joiningPrivate) return false;
  joiningPrivate = true;
  const btn = $('btn-join-table');
  if (btn) btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('join_private_table', { p_code: code });
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || row.ok === false) throw new Error(row?.error || 'Could not join this table.');
    currentCode = code;
    toast(row.already_seated ? 'Welcome back to the table! 🔒' : 'Joined the table! 🎉');
    await enterTable(row.table_id, code);
    return true;
  } catch (e) {
    showError(friendlyError(e, 'Could not join. Check the code and try again.'));
    return false;
  } finally {
    joiningPrivate = false;
    if (btn) btn.disabled = false;
  }
}

async function joinTable() {
  unlockAudio();
  await joinTableByCode($('join-code-input').value);
}

export async function joinPrivateTableByCode(code) {
  return joinTableByCode(code);
}

/* ---------------- table state ---------------- */
async function enterTable(tableId, code) {
  if (code) currentCode = normalizeInviteCode(code);
  // Full-screen play mode while seated at a table.
  document.body.classList.add('playing');
  document.body.classList.remove('has-tabs');
  $('tabbar').hidden = true;
  $('topbar').style.display = 'none';
  $('private-lobby').hidden = true;
  $('private-table').hidden = false;
  $('private-code-label').textContent = '· ' + (code || '');
  lastRoundSeen = null;
  resultPoppedFor = 0;
  knownBidIds = new Set();
  stagePrimed = false;
  highlightMap = {};
  highlightUntil = 0;
  await refreshTable(tableId);
  subscribe(tableId);
  startPoll(tableId);
}

async function refreshTable(tableId) {
  try {
    const { data: t, error: tErr } = await supabase.from('private_tables').select('*').eq('id', tableId).maybeSingle();
    if (tErr) console.warn('private table load failed', tErr);
    table = unwrapRow(t);
    if (table?.code) currentCode = normalizeInviteCode(table.code);
    const { data: s, error: sErr } = await supabase.from('private_seats').select('*')
      .eq('table_id', tableId).order('seat_no', { ascending: true });
    if (sErr) console.warn('private seats load failed', sErr);
    seats = Array.isArray(s) ? s : [];
    // Resolve real display names for the seated players.
    try {
      const ids = [...new Set(seats.map(x => x.user_id).filter(Boolean))];
      if (ids.length) {
        const { data: profs } = await supabase.from('public_profiles')
          .select('id, display_name').in('id', ids);
        if (Array.isArray(profs)) profs.forEach(p => { if (p?.id && p.display_name) seatNames[p.id] = p.display_name; });
      }
    } catch (_) { /* names are cosmetic; seats still render */ }
    const { data: b, error: bErr } = await supabase.from('private_bids').select('*').eq('table_id', tableId);
    if (bErr) console.warn('private bids load failed', bErr);
    bids = Array.isArray(b) ? b : [];
    renderTable();
  } catch (e) { console.warn('private table refresh failed', e); }
}

function seatName(seat) {
  if (seat.user_id === userId) return myName;
  return seatNames[seat.user_id] || seat.display_name || seat.player_name || seat.name ||
    ('Player ' + String(seat.user_id || '?').slice(0, 4));
}
function roundBids() {
  // Only the current round's bids count — bids from earlier rounds of
  // this table must not show as this round's bids or totals.
  const rno = table?.current_round_no;
  if (rno == null) return bids;
  return bids.filter(b => Number(b.round_no ?? rno) === Number(rno));
}
function seatBid(seat) {
  // Match ONLY by user_id. (private_bids has no seat_id and
  // private_seats has no id — comparing those compared
  // undefined === undefined, which matched the FIRST bid for
  // every seat, so all seats showed the first bidder's amount.)
  const b = roundBids().find(x => x.user_id === seat.user_id);
  return b ? Number(b.amount) : null;
}

// Spin state: a round is ready when every seated player has bid
// (>= 2 bids). The spin turn rotates by round over the seated players
// in seat order — the same rule the server enforces in
// spin_private_table. Bidding itself has no turn order.
function spinState() {
  const rb = roundBids();
  const ready = seats.length >= 2 && rb.length >= 2 && seats.every(s => seatBid(s) != null);
  const spinner = ready ? seats[(Number(table.current_round_no) - 1) % seats.length] : null;
  return { ready, spinner };
}

function renderTable() {
  // A round that just resolved: seat highlights + personal win/lose pop-up.
  const rnoNow = table?.current_round_no;
  if (lastRoundSeen != null && rnoNow != null && rnoNow > lastRoundSeen) {
    for (let r = lastRoundSeen; r < rnoNow; r++) onRoundResolved(r);
  }
  if (rnoNow != null) lastRoundSeen = rnoNow;
  curSpin = table ? spinState() : { ready: false, spinner: null };

  // seats (always 4 slots)
  const wrap = $('private-seats');
  wrap.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const seat = seats[i];
    const div = document.createElement('div');
    if (!seat) {
      div.className = 'seat empty';
      div.innerHTML = '<div class="seat-emoji">🪑</div><div class="seat-name">Empty seat</div><div class="seat-bid">waiting…</div>';
    } else {
      const bid = seatBid(seat);
      const hl = (Date.now() < highlightUntil && highlightMap[seat.user_id])
        ? ' seat-' + highlightMap[seat.user_id] : '';
      const turn = (curSpin.ready && curSpin.spinner && curSpin.spinner.user_id === seat.user_id)
        ? ' seat-turn' : '';
      div.className = 'seat filled' + (seat.user_id === userId ? ' you' : '') + hl + turn;
      div.innerHTML = '<div class="seat-emoji">🤑</div><div class="seat-name"></div>' +
        '<div class="seat-bid">' + (bid != null ? 'Bid: Rs ' + fmtRs(bid) : 'thinking…') + '</div>';
      div.querySelector('.seat-name').textContent = seatName(seat);
    }
    wrap.appendChild(div);
  }

  // clock: starts on first bid (30s)
  const endsAt = table?.current_ends_at || table?.round_ends_at || table?.ends_at;
  const anyBid = roundBids().length > 0;
  clearInterval(clockInt);
  if (curSpin.ready) {
    $('private-clock').textContent = (curSpin.spinner.user_id === userId)
      ? '🎯 Your turn — tap the POT to spin!'
      : '⏳ Waiting for ' + seatName(curSpin.spinner) + ' to spin the pot…';
    $('private-clock').classList.remove('urgent');
  } else if (!anyBid || !endsAt) {
    $('private-clock').textContent = anyBid ? '⏳ Waiting for all players to bid…' : '⏳ Waiting for first bid…';
    $('private-clock').classList.remove('urgent');
  } else {
    let lastTick = -1;
    clockInt = setInterval(() => {
      const remain = Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 1000));
      $('private-clock').textContent = '⏱ ' + remain + 's';
      $('private-clock').classList.toggle('urgent', remain <= 10);
      if (remain <= 10 && remain > 0 && remain !== lastTick) { lastTick = remain; sounds.tick(); }
      if (remain <= 0) { clearInterval(clockInt); setTimeout(() => refreshTable(table.id), 1500); }
    }, 250);
  }

  // total: reveals only after ALL seated players have bid (min 2 to start)
  const filledSeats = seats.length;
  const rBids = roundBids();
  const totalEl = $('private-total');
  if (filledSeats >= 2 && rBids.length >= filledSeats) {
    const total = rBids.reduce((a, b) => a + Number(b.amount || 0), 0);
    totalEl.innerHTML = '💰 Total pot: <strong>Rs ' + fmtRs(total) + '</strong>';
  } else if (filledSeats < 2) {
    totalEl.textContent = 'Waiting for players — 2 needed to start (' + filledSeats + '/2 seated)';
  } else {
    totalEl.textContent = 'Total reveals after all seated players bid (' + rBids.length + '/' + filledSeats + ' bids in)';
  }

  renderStage();

  // results
  const status = table?.status;
  if (status === 'closed' || status === 'settled') renderResults();
  else $('private-results').hidden = true;
}

function renderResults() {
  const box = $('private-results');
  const list = $('private-results-list');
  // Highest bid loses; order the rest as winners (desc by amount).
  const ranked = bids
    .map(b => ({ name: nameForBid(b), amount: Number(b.amount || 0) }))
    .sort((a, b) => b.amount - a.amount);
  list.innerHTML = '';
  ranked.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'winner-row';
    const tag = i === 0 ? '😭 lost' : '🏆';
    div.innerHTML = '<span class="rank">' + tag + '</span><span class="name"></span>' +
      '<span class="amount">Rs ' + fmtRs(r.amount) + '</span>';
    div.querySelector('.name').textContent = r.name + (i === 0 ? ' — highest bid loses' : '');
    list.appendChild(div);
  });
  box.hidden = false;
}
function nameForBid(b) {
  const seat = seats.find(s => s.user_id === b.user_id);
  if (seat) return seatName(seat);
  if (b.user_id === userId) return myName;
  return seatNames[b.user_id] || 'Player';
}

/* ---------------- round resolved: highlights + pop-up ---------------- */
// Seat slot angles for the arrow (➤ points right at 0deg; CSS rotate is
// clockwise). Slot order is the seats grid: 0 top-left, 1 top-right,
// 2 bottom-left, 3 bottom-right.
const SEAT_ANGLES = { 0: -135, 1: -45, 2: 135, 3: 45 };

function onRoundResolved(r) {
  // The player who clicked the pot already ran their own spin + reveal.
  if (r === localSpinRound) { localSpinRound = null; return; }
  const rb = bids.filter(b => Number(b.round_no ?? r) === r);
  if (!rb.length) return;
  // Highest bid loses; ties go to the earliest bid (same rule as server).
  const sorted = [...rb].sort((a, b) =>
    (Number(b.amount) - Number(a.amount)) ||
    (new Date(a.placed_at) - new Date(b.placed_at)));
  const loser = sorted[0];
  if (resultPoppedFor >= r) return;
  resultPoppedFor = r;
  const mine = rb.find(b => b.user_id === userId);
  const loserIdx = seats.findIndex(s => s.user_id === loser.user_id);
  const reveal = () => {
    highlightMap = {};
    rb.forEach(b => { highlightMap[b.user_id] = (b.user_id === loser.user_id) ? 'lose' : 'win'; });
    highlightUntil = Date.now() + 4000;
    renderTable();
    if (mine) showPrivateResult(rb, loser, mine);
  };
  if (loserIdx < 0) { reveal(); return; }
  // Game show moment: the clock needle spins for 5 seconds like a
  // roller and stops on the loser — the player who bid the highest.
  const actEl = $('private-activity');
  if (actEl) actEl.textContent = '🎯 Spinning the needle…';
  spinArrowTo(loserIdx, reveal);
}

function spinArrowTo(seatIdx, done) {
  const needle = $('pot-needle');
  clearTimeout(spinTimer);
  if (!needle) { done(); return; }
  // The needle points UP at 0deg (the old arrow pointed right), so the
  // seat angles shift by +90.
  const target = (SEAT_ANGLES[seatIdx] ?? 0) + 90;
  const delta = ((target - arrowDeg) % 360 + 360) % 360;
  arrowDeg = arrowDeg + 360 * 5 + delta;
  needle.style.transform = 'rotate(' + arrowDeg + 'deg)';
  spinTimer = setTimeout(done, 5000);
}

/* ------------- pot click: the rotation spinner starts the round ------------ */
async function onPotClick() {
  if (!table || spinInFlight) return;
  const { ready, spinner } = spinState();
  if (!ready || !spinner || spinner.user_id !== userId) return;
  spinInFlight = true;
  const rno = Number(table.current_round_no);
  const rb = roundBids().slice();
  try {
    const { data, error } = await supabase.rpc('spin_private_table', { p_table_id: table.id });
    if (error) throw error;
    if (data && data.ok === false) throw new Error(data.error || 'Could not spin.');
  } catch (e) {
    spinInFlight = false;
    toast(friendlyError(e, 'Could not spin. Try again.'), true);
    refreshTable(table.id);
    return;
  }
  // The round is resolved on the server. Spin this client's needle to
  // the loser and reveal; other clients spin via onRoundResolved.
  localSpinRound = rno;
  resultPoppedFor = rno;
  const sorted = [...rb].sort((a, b) =>
    (Number(b.amount) - Number(a.amount)) ||
    (new Date(a.placed_at) - new Date(b.placed_at)));
  const loser = sorted[0];
  const loserIdx = seats.findIndex(s => s.user_id === loser.user_id);
  const actEl = $('private-activity');
  if (actEl) actEl.textContent = '🎯 Spinning the needle…';
  const reveal = () => {
    highlightMap = {};
    rb.forEach(b => { highlightMap[b.user_id] = (b.user_id === loser.user_id) ? 'lose' : 'win'; });
    highlightUntil = Date.now() + 4000;
    spinInFlight = false;
    renderTable();
    const mine = rb.find(b => b.user_id === userId);
    if (mine) showPrivateResult(rb, loser, mine);
    refreshTable(table.id);
  };
  if (loserIdx < 0) { reveal(); return; }
  spinArrowTo(loserIdx, reveal);
}

function showPrivateResult(rb, loser, mine) {
  const modal = $('result-modal');
  if (!modal) return;
  const card = modal.querySelector('.result-card');
  if (loser.user_id === userId) {
    sounds.lose();
    if (navigator.vibrate) navigator.vibrate([400]);
    $('result-emoji').textContent = '😭';
    $('result-title').textContent = 'You Lost';
    $('result-amount').textContent = '-Rs ' + fmtRs(mine.amount);
    $('result-amount').style.color = '#ef4444';
    $('result-sub').textContent = 'Highest bid loses — your Rs ' + fmtRs(mine.amount) + ' went to the other players. Better luck next round!';
    card.classList.add('lost');
  } else {
    // Same payout math as the server: winners split 90% of the loser's
    // bid in proportion to their own bids (floored to the paisa).
    const dist = Math.floor(Number(loser.amount) * 0.90 * 100) / 100;
    const wtot = rb.filter(b => b.user_id !== loser.user_id)
                   .reduce((a, b) => a + Number(b.amount || 0), 0);
    const payout = wtot > 0 ? Math.floor((dist * Number(mine.amount) / wtot) * 100) / 100 : 0;
    sounds.win();
    if (navigator.vibrate) navigator.vibrate([100, 50, 200, 50, 300]);
    $('result-emoji').textContent = '🎉';
    $('result-title').textContent = 'You Won!';
    $('result-amount').textContent = '+Rs ' + fmtRs(payout);
    $('result-amount').style.color = '#22c55e';
    $('result-sub').textContent = nameForBid(loser) + ' bid the highest (Rs ' + fmtRs(loser.amount) + ') and lost. +Rs ' + fmtRs(payout) + ' added to your wallet! 🎉';
    card.classList.remove('lost');
  }
  modal.hidden = false;
  modal.style.display = 'flex';
}

/* ---------------- table stage: pot, chip fly-in, activity ---------------- */
function renderStage() {
  const pot = $('stage-pot');
  const chipsEl = $('pot-chips');
  const actEl = $('private-activity');
  if (!pot || !chipsEl || !actEl) return;
  const rb = roundBids();
  chipsEl.textContent = rb.length ? '🪙'.repeat(Math.min(rb.length, 8)) : '·';
  const countEl = $('pot-count');
  if (countEl) countEl.textContent = rb.length
    ? rb.length + (rb.length === 1 ? ' bid in' : ' bids in') : 'no bids yet';
  // Fly a chip to the pot for any bid that appeared since the last render.
  let newBid = null;
  rb.forEach(b => { if (b.id && !knownBidIds.has(b.id)) { knownBidIds.add(b.id); newBid = b; } });
  if (newBid && stagePrimed) {
    flyChipToPot(newBid);
    pot.classList.remove('pot-pop');
    void pot.offsetWidth;
    pot.classList.add('pot-pop');
  }
  stagePrimed = true;
  // The pot pulses for the player whose spin turn it is.
  pot.classList.toggle('pot-ready',
    !!(curSpin.ready && curSpin.spinner && curSpin.spinner.user_id === userId && !spinInFlight));
  // Activity line: the latest action at the table.
  if (curSpin.ready) {
    actEl.textContent = (curSpin.spinner.user_id === userId)
      ? '🎯 All bids in — tap the POT to spin!'
      : '🎯 All bids in — ' + seatName(curSpin.spinner) + ' will spin the pot…';
  } else if (rb.length) {
    const last = [...rb].sort((a, b) => new Date(a.placed_at) - new Date(b.placed_at)).at(-1);
    actEl.textContent = '⚡ ' + nameForBid(last) + ' bid Rs ' + fmtRs(last.amount);
  } else if (seats.length) {
    actEl.textContent = seats.length + ' player' + (seats.length === 1 ? '' : 's') + ' at the table — waiting for the first bid…';
  } else {
    actEl.textContent = 'Waiting for players…';
  }
}

function flyChipToPot(bid) {
  try {
    const stage = $('private-stage');
    const pot = $('stage-pot');
    if (!stage || !pot) return;
    const idx = seats.findIndex(s => s.user_id === bid.user_id);
    const seatEl = idx >= 0 ? $('private-seats').children[idx] : null;
    const sr = stage.getBoundingClientRect();
    const pr = pot.getBoundingClientRect();
    const chip = document.createElement('span');
    chip.className = 'chip-fly';
    chip.textContent = '🪙';
    let sx = pr.left - sr.left + pr.width / 2 - 10;
    let sy = -8;
    if (seatEl) {
      const r = seatEl.getBoundingClientRect();
      sx = r.left - sr.left + r.width / 2 - 10;
      sy = r.top - sr.top + r.height / 2 - 12;
    }
    chip.style.left = sx + 'px';
    chip.style.top = sy + 'px';
    stage.appendChild(chip);
    requestAnimationFrame(() => {
      chip.style.left = (pr.left - sr.left + pr.width / 2 - 10) + 'px';
      chip.style.top = (pr.top - sr.top + pr.height / 2 - 12) + 'px';
      chip.style.opacity = '0.35';
      chip.style.transform = 'scale(0.7)';
    });
    setTimeout(() => chip.remove(), 750);
  } catch (_) { /* animation is cosmetic */ }
}

/* ---------------- placing a private bid ---------------- */
async function placePrivateBid() {
  unlockAudio();
  if (!table?.id) return;
  let amount;
  if (selectedBid === 'custom') {
    amount = Number($('private-custom-input').value);
  } else amount = selectedBid;
  if (!amount || amount < 50) { toast('Minimum private bid is Rs 50.', true); return; }
  if (amount > 10000) { toast('Maximum private bid is Rs 10,000.', true); return; }
  $('btn-private-bid').disabled = true;
  try {
    const { data, error } = await supabase.rpc('place_private_bid', {
      p_table_id: table.id, p_amount: amount,
    });
    if (error) throw error;
    const row = unwrapRow(data);
    if (row && row.ok === false) throw new Error(row.error || 'Bid rejected');
    sounds.click();
    toast('⚡ Private bid of Rs ' + fmtRs(amount) + ' placed!');
    await refreshTable(table.id);
  } catch (e) {
    toast(friendlyError(e, 'Bid failed. Try again.'), true);
  } finally {
    $('btn-private-bid').disabled = false;
  }
}

/* ---------------- realtime ---------------- */
function subscribe(tableId) {
  unsubscribe();
  const ch = supabase
    .channel('private-' + tableId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'private_tables',
        filter: 'id=eq.' + tableId }, () => refreshTable(tableId))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'private_seats',
        filter: 'table_id=eq.' + tableId }, () => refreshTable(tableId))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'private_bids',
        filter: 'table_id=eq.' + tableId }, () => refreshTable(tableId))
    .subscribe();
  channels.push(ch);
}
function unsubscribe() {
  channels.forEach(c => { try { supabase.removeChannel(c); } catch {} });
  channels = [];
  clearInterval(clockInt);
  stopPoll();
}

/* Live safety net: realtime delivers changes instantly; this 1s poll
   guarantees other players' joins/leaves/bids show right away even
   if a realtime event is ever missed. */
function startPoll(tableId) {
  stopPoll();
  pollInt = setInterval(() => {
    if (table?.id === tableId && !document.hidden) refreshTable(tableId);
  }, 1000);
}
function stopPoll() {
  if (pollInt) { clearInterval(pollInt); pollInt = null; }
}

function exitToLobby() {
  // Back to the lobby: restore the menu bars.
  document.body.classList.remove('playing');
  document.body.classList.add('has-tabs');
  $('tabbar').hidden = false;
  $('topbar').style.display = 'flex';
  unsubscribe();
  clearTimeout(spinTimer);
  spinTimer = null;
  table = null;
  currentCode = '';
  leaveArmed = false;
  const btn = $('btn-leave-table');
  if (btn) { btn.disabled = false; btn.textContent = 'Leave table'; }
  $('private-table').hidden = true;
  $('private-lobby').hidden = false;
  $('invite-code-card').hidden = true;
}

/* Leave for real: the seat is deleted on the server, so the player
   disappears from everyone else's screen at once (realtime + poll).
   Two-tap in-app confirm — JS confirm() is banned (WebView). */
async function leaveTable() {
  unlockAudio();
  if (!table?.id) { exitToLobby(); return; }
  const btn = $('btn-leave-table');
  if (!leaveArmed) {
    leaveArmed = true;
    btn.textContent = 'Tap again to leave';
    toast('Tap Leave again to confirm — your seat will be freed for the others.');
    clearTimeout(leaveArmTimer);
    leaveArmTimer = setTimeout(() => {
      leaveArmed = false;
      btn.textContent = 'Leave table';
    }, 4000);
    return;
  }
  clearTimeout(leaveArmTimer);
  leaveArmed = false;
  btn.disabled = true;
  btn.textContent = 'Leaving…';
  const tableId = table.id;
  try {
    const { data, error } = await supabase.rpc('leave_private_table', { p_table_id: tableId });
    if (error) throw error;
    const row = unwrapRow(data);
    if (row && row.ok === false) throw new Error(row.error || 'Could not leave the table.');
    toast('You left the table. 👋');
  } catch (e) {
    toast(friendlyError(e, 'Could not leave cleanly — you have exited on this device.'), true);
  }
  exitToLobby();
}

/* ---------------- init ---------------- */
export function initPrivate() {
  $('btn-create-table').addEventListener('click', createTable);
  $('btn-join-table').addEventListener('click', joinTable);
  $('btn-copy-code').addEventListener('click', () =>
    copyText($('invite-code').textContent.trim(), 'Invite code copied!'));
  $('btn-share-code')?.addEventListener('click', shareInviteLink);
  $('btn-copy-link')?.addEventListener('click', copyInviteLink);
  $('btn-share-table')?.addEventListener('click', shareInviteLink);
  $$('.pbid-tab').forEach(tab => tab.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('.pbid-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    selectedBid = tab.dataset.amount === 'custom' ? 'custom' : Number(tab.dataset.amount);
    $('private-custom-row').hidden = selectedBid !== 'custom';
  }));
  $('btn-private-bid').addEventListener('click', placePrivateBid);
  $('stage-pot')?.addEventListener('click', onPotClick);
  $('btn-leave-table').addEventListener('click', leaveTable);
  // The win/lose pop-up reuses the shared result modal; wire its close
  // button here too (arena.js wires it as well — hiding twice is harmless).
  $('btn-result-close')?.addEventListener('click', () => {
    const m = $('result-modal');
    if (m) { m.hidden = true; m.style.display = ''; }
  });
}

export function destroyPrivate() { unsubscribe(); }
