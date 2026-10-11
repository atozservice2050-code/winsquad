/* ============================================================
   PRIVATE TABLES — 4 seats, invite code, min bid Rs 500.
   - create_private_table() -> {table_id, code}
   - join_private_table(p_code) -> {ok, error, table_id}
   - place_private_bid(p_table_id, p_amount)
   - Reads: private_tables / private_seats / private_bids for
     tables the user sits at (realtime subscribed).
   Rules reflected: clock starts on FIRST bid (30s); only the 1
   highest bidder loses; total reveals only after ALL 4 have bid.
   Column names below are best-effort guesses against the backend
   contract — every read is defensive (see README "Backend contract").
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, $$, toast, fmtRs, sounds, unlockAudio, copyText } from './util.js';

let table = null;          // private_tables row
let seats = [];            // private_seats rows
let bids = [];             // private_bids rows (current round)
let selectedBid = 800;
let clockInt = null;
let channels = [];
let userId = null;
let myName = 'You';

export function setUser(id, displayName) { userId = id; myName = displayName || 'You'; }

function showError(msg) {
  const el = $('private-error');
  el.textContent = msg;
  el.hidden = false;
}
function hideError() { $('private-error').hidden = true; }

/* ---------------- lobby: create / join ---------------- */
async function createTable() {
  unlockAudio(); hideError();
  $('btn-create-table').disabled = true;
  try {
    const { data, error } = await supabase.rpc('create_private_table');
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || !row.table_id) throw new Error('Could not create the table.');
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

async function joinTable() {
  unlockAudio(); hideError();
  const code = $('join-code-input').value.trim().toUpperCase();
  if (!code) { showError('Enter the invite code.'); return; }
  $('btn-join-table').disabled = true;
  try {
    const { data, error } = await supabase.rpc('join_private_table', { p_code: code });
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || row.ok === false) throw new Error(row?.error || 'Could not join this table.');
    toast('Joined the table! 🎉');
    await enterTable(row.table_id, code);
  } catch (e) {
    showError(friendlyError(e, 'Could not join. Check the code and try again.'));
  } finally {
    $('btn-join-table').disabled = false;
  }
}

/* ---------------- table state ---------------- */
async function enterTable(tableId, code) {
  $('private-lobby').hidden = true;
  $('private-table').hidden = false;
  $('private-code-label').textContent = '· ' + (code || '');
  await refreshTable(tableId);
  subscribe(tableId);
}

async function refreshTable(tableId) {
  try {
    const { data: t } = await supabase.from('private_tables').select('*').eq('id', tableId).maybeSingle();
    table = unwrapRow(t);
    const { data: s } = await supabase.from('private_seats').select('*').eq('table_id', tableId);
    seats = Array.isArray(s) ? s : [];
    const { data: b } = await supabase.from('private_bids').select('*').eq('table_id', tableId);
    bids = Array.isArray(b) ? b : [];
    renderTable();
  } catch (e) { console.warn('private table refresh failed', e); }
}

function seatName(seat) {
  if (seat.user_id === userId) return myName + ' (you)';
  return seat.display_name || seat.player_name || seat.name ||
    ('Player ' + String(seat.user_id || '?').slice(0, 4));
}
function seatBid(seat) {
  const b = bids.find(x => x.user_id === seat.user_id || x.seat_id === seat.id);
  return b ? Number(b.amount) : null;
}

function renderTable() {
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
      div.className = 'seat filled' + (seat.user_id === userId ? ' you' : '');
      div.innerHTML = '<div class="seat-emoji">🤑</div><div class="seat-name"></div>' +
        '<div class="seat-bid">' + (bid != null ? 'Bid: Rs ' + fmtRs(bid) : 'thinking…') + '</div>';
      div.querySelector('.seat-name').textContent = seatName(seat);
    }
    wrap.appendChild(div);
  }

  // clock: starts on first bid (30s)
  const endsAt = table?.current_ends_at || table?.round_ends_at || table?.ends_at;
  const anyBid = bids.length > 0;
  clearInterval(clockInt);
  if (!anyBid || !endsAt) {
    $('private-clock').textContent = anyBid ? 'Starting…' : '⏳ Waiting for first bid…';
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

  // total: reveals only after ALL 4 seats have bid
  const filledSeats = seats.length;
  const totalEl = $('private-total');
  if (filledSeats >= 4 && bids.length >= 4) {
    const total = bids.reduce((a, b) => a + Number(b.amount || 0), 0);
    totalEl.innerHTML = '💰 Total pot: <strong>Rs ' + fmtRs(total) + '</strong>';
  } else {
    totalEl.textContent = 'Total reveals after all 4 players bid (' + bids.length + '/4 bids in)';
  }

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
  const seat = seats.find(s => s.user_id === b.user_id || s.id === b.seat_id);
  return seat ? seatName(seat) : 'Player';
}

/* ---------------- placing a private bid ---------------- */
async function placePrivateBid() {
  unlockAudio();
  if (!table?.id) return;
  let amount;
  if (selectedBid === 'custom') {
    amount = Number($('private-custom-input').value);
  } else amount = selectedBid;
  if (!amount || amount < 500) { toast('Minimum private bid is Rs 500.', true); return; }
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
}

/* ---------------- init ---------------- */
export function initPrivate() {
  $('btn-create-table').addEventListener('click', createTable);
  $('btn-join-table').addEventListener('click', joinTable);
  $('btn-copy-code').addEventListener('click', () =>
    copyText($('invite-code').textContent.trim(), 'Invite code copied!'));
  $$('.pbid-tab').forEach(tab => tab.addEventListener('click', () => {
    unlockAudio(); sounds.click();
    $$('.pbid-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    selectedBid = tab.dataset.amount === 'custom' ? 'custom' : Number(tab.dataset.amount);
    $('private-custom-row').hidden = selectedBid !== 'custom';
  }));
  $('btn-private-bid').addEventListener('click', placePrivateBid);
  $('btn-leave-table').addEventListener('click', () => {
    unsubscribe();
    table = null;
    $('private-table').hidden = true;
    $('private-lobby').hidden = false;
    $('invite-code-card').hidden = true;
  });
}

export function destroyPrivate() { unsubscribe(); }
