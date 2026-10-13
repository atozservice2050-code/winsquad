/* ============================================================
   PROFILE — b9-style MY ACCOUNT: gold card, VIP level, member
   center grid, betting record, profit/loss. Keeps display name,
   phone, referral ID, 14-digit transfer ID, copy, logout, admin.
   ============================================================ */
import { $, copyText, unlockAudio, toast, fmtRs } from './util.js';
import { logout } from './auth.js';
import { supabase } from './supabase-client.js';
import { refreshWallet } from './wallet.js';

const AVATARS = ['😎','🦁','🐯','🦊','🐼','🐨','🦄','🐸','🐵','🐙','🦋','🐝','🦖','🐳','🍀','⚡','🔥','💎','👑','🎯','🚀','🌟'];

const VIP_TIERS = [
  { min: 10, name: 'Diamond' },
  { min: 5, name: 'Gold' },
  { min: 3, name: 'Silver' },
  { min: 2, name: 'Bronze' },
  { min: 1, name: 'Rookie' },
];

let currentUserId = null;

export function renderProfile(profile, phone) {
  const name = profile?.display_name || '–';
  $('profile-name').textContent = name;
  $('profile-nickname').textContent = name;
  $('profile-phone').textContent = phone || profile?.phone || '–';
  $('profile-referral').textContent = profile?.referral_id || '–';
  $('profile-transfer').textContent = profile?.transfer_id || '–';
  $('profile-avatar').textContent = profile?.avatar || '😎';
  // Joined date
  try {
    const d = profile?.created_at ? new Date(profile.created_at) : null;
    $('profile-joined').textContent = d
      ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '–';
  } catch { $('profile-joined').textContent = '–'; }
  if (profile?.id) {
    currentUserId = profile.id;
    loadVipStats();
    loadAccountBalance();
  }
}

/* VIP level from total wagered: 1 level per Rs 1000 wagered. */
async function loadVipStats() {
  if (!currentUserId) return;
  try {
    let total = 0;
    // Squad Stakes bids
    const { data: bids } = await supabase.from('bids')
      .select('amount').eq('user_id', currentUserId);
    (bids || []).forEach(b => { total += Number(b.amount || 0); });
    // Coin Flip bids
    try {
      const { data: cfBids } = await supabase.from('cf_bids')
        .select('amount').eq('user_id', currentUserId);
      (cfBids || []).forEach(b => { total += Number(b.amount || 0); });
    } catch { /* cf tables may not exist yet */ }

    const level = Math.min(99, 1 + Math.floor(total / 1000));
    const xp = Math.floor(total % 1000);
    const tier = (VIP_TIERS.find(t => level >= t.min) || VIP_TIERS[VIP_TIERS.length - 1]).name;
    $('vip-level').textContent = level;
    $('vip-level2').textContent = level;
    $('vip-next').textContent = level + 1;
    $('vip-tier').textContent = tier;
    $('vip-fill').style.width = (xp / 1000 * 100).toFixed(1) + '%';
    $('vip-xp').textContent = xp.toLocaleString() + ' / 1000 XP';
    $('vip-remaining').textContent = (1000 - xp).toLocaleString();
  } catch (e) { console.warn('vip stats failed', e); }
}

/* Balance on the gold card (mirrors wallet). */
async function loadAccountBalance() {
  try {
    const { data } = await supabase.from('wallets')
      .select('balance').eq('user_id', currentUserId).maybeSingle();
    const bal = data ? Number(data.balance || 0) : 0;
    $('acct-balance').textContent = fmtRs(bal);
  } catch (e) { console.warn('balance load failed', e); }
}

/* Betting record / Profit & Loss panel. */
async function showRecord(kind) {
  const panel = $('record-panel');
  const list = $('record-list');
  $('record-title').textContent = kind === 'pnl' ? '📈 Profit & Loss' : '📊 Betting Record';
  panel.hidden = false;
  list.innerHTML = '<p class="hint">Loading…</p>';
  if (!currentUserId) { list.innerHTML = '<p class="hint">Not signed in.</p>'; return; }
  try {
    if (kind === 'pnl') {
      // Sum wins and losses from transactions
      const { data } = await supabase.from('transactions')
        .select('type, amount').eq('user_id', currentUserId);
      let won = 0, lost = 0;
      (data || []).forEach(t => {
        const a = Number(t.amount || 0);
        if (t.type === 'coinflip_win' || t.type === 'payout') won += a;
        else if (t.type === 'coinflip_bet' || t.type === 'bid') lost += a;
      });
      const net = won - lost;
      list.innerHTML =
        '<div class="profile-row"><span>Total won</span><strong style="color:#2ee06f">Rs ' + fmtRs(won) + '</strong></div>' +
        '<div class="profile-row"><span>Total wagered</span><strong>Rs ' + fmtRs(lost) + '</strong></div>' +
        '<div class="profile-row"><span>Net P&amp;L</span><strong style="color:' + (net >= 0 ? '#2ee06f' : '#ff5555') + '">Rs ' + fmtRs(net) + '</strong></div>';
    } else {
      // Recent bids (Squad Stakes + Coin Flip)
      const rows = [];
      const { data: bids } = await supabase.from('bids')
        .select('amount, created_at').eq('user_id', currentUserId)
        .order('created_at', { ascending: false }).limit(10);
      (bids || []).forEach(b => rows.push({ label: 'Squad Stakes bid', amount: b.amount, at: b.created_at }));
      try {
        const { data: cfBids } = await supabase.from('cf_bids')
          .select('amount, side, created_at').eq('user_id', currentUserId)
          .order('created_at', { ascending: false }).limit(10);
        (cfBids || []).forEach(b => rows.push({ label: 'Coin Flip · ' + b.side, amount: b.amount, at: b.created_at }));
      } catch { /* ignore */ }
      rows.sort((a, b) => new Date(b.at) - new Date(a.at));
      if (!rows.length) { list.innerHTML = '<p class="hint">No bets yet.</p>'; return; }
      list.innerHTML = rows.slice(0, 15).map(r =>
        '<div class="profile-row"><span>' + r.label + '</span><strong>Rs ' + fmtRs(r.amount) + '</strong></div>'
      ).join('');
    }
  } catch (e) {
    console.warn('record load failed', e);
    list.innerHTML = '<p class="hint">Could not load.</p>';
  }
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildAvatarGrid() {
  const grid = $('avatar-grid');
  grid.innerHTML = '';
  AVATARS.forEach(a => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a;
    btn.addEventListener('click', async () => {
      unlockAudio();
      await saveAvatar(a);
    });
    grid.appendChild(btn);
  });
}

async function saveAvatar(emoji) {
  if (!currentUserId) { toast('Not signed in', true); return; }
  try {
    // Use the safe RPC (profiles has no client UPDATE policy)
    const { data, error } = await supabase.rpc('update_avatar', { p_avatar: emoji });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (row && row.ok === false) throw new Error(row.error || 'Avatar rejected');
    $('profile-avatar').textContent = emoji;
    $('avatar-picker').hidden = true;
    toast('Avatar updated! ' + emoji);
  } catch (e) {
    console.warn('avatar save failed', e);
    toast(e.message || 'Could not save avatar', true);
  }
}

// Check if user is admin, show admin button
async function checkAdminAccess() {
  try {
    const { data } = await supabase.rpc('is_admin');
    const isAdmin = Array.isArray(data) ? data[0] === true : data === true;
    if (isAdmin) {
      $('btn-admin-portal').hidden = false;
    }
  } catch (e) { /* not admin or error */ }
}

async function saveName() {
  const input = $('name-input');
  const name = input.value.trim();
  if (!name) { toast('Enter a name', true); return; }
  if (!currentUserId) { toast('Not signed in', true); return; }
  try {
    // Use the safe RPC (profiles has no client UPDATE policy)
    const { data, error } = await supabase.rpc('update_display_name', { p_name: name });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (row && row.ok === false) throw new Error(row.error || 'Name rejected');
    $('profile-name').textContent = name;
    $('name-edit-row').hidden = true;
    toast('Name updated!');
  } catch (e) {
    console.warn('name save failed', e);
    toast(e.message || 'Could not save name', true);
  }
}

export function initProfile() {
  // Null-safe handler attachment: every button must work even if others are missing.
  const on = (id, handler) => {
    try {
      const el = $(id);
      if (el) el.addEventListener('click', handler);
      else console.warn('initProfile: missing element #' + id);
    } catch (e) { console.warn('initProfile handler failed for #' + id, e); }
  };

  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      unlockAudio();
      const target = $(btn.dataset.copy);
      if (target) copyText(target.textContent.trim(), 'Copied!');
    });
  });

  // Switch account = logout (no confirm() — JS dialogs don't work in all WebViews)
  on('btn-logout', async () => {
    await logout();
  });

  // Change password panel
  const pwPanel = $('pw-panel');
  on('btn-change-pw', () => {
    unlockAudio();
    if (!pwPanel) return;
    $('pw-error').hidden = true;
    $('pw-ok').hidden = true;
    pwPanel.hidden = !pwPanel.hidden;
  });
  on('btn-pw-close', () => { if (pwPanel) pwPanel.hidden = true; });
  on('btn-pw-save', async () => {
    const errEl = $('pw-error'), okEl = $('pw-ok');
    errEl.hidden = true; okEl.hidden = true;
    const pw1 = $('pw-new').value, pw2 = $('pw-confirm').value;
    if (!pw1 || pw1.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.hidden = false; return; }
    if (pw1 !== pw2) { errEl.textContent = 'Passwords do not match.'; errEl.hidden = false; return; }
    $('btn-pw-save').disabled = true;
    try {
      const { error } = await supabase.auth.updateUser({ password: pw1 });
      if (error) throw error;
      $('pw-new').value = ''; $('pw-confirm').value = '';
      okEl.textContent = 'Password changed successfully!';
      okEl.hidden = false;
    } catch (e) {
      errEl.textContent = e?.message || 'Could not change password. Try again.';
      errEl.hidden = false;
    } finally {
      $('btn-pw-save').disabled = false;
    }
  });

  // Admin portal button (only for admins) — member grid item
  const adminBtn = $('btn-admin-portal');
  if (adminBtn) adminBtn.addEventListener('click', () => {
    window.open('/admin', '_blank');
  });
  checkAdminAccess();

  // Balance refresh
  $('btn-refresh-balance').addEventListener('click', async () => {
    unlockAudio();
    try { await refreshWallet(); } catch {}
    await loadAccountBalance();
    toast('Balance updated');
  });

  // GET COINS → rewards tab; GAME CARDS → toast for now
  $('btn-get-coins').addEventListener('click', () => {
    unlockAudio();
    const el = document.querySelector('[data-open-view="rewards"]');
    if (el) el.click();
    else toast('Open Rewards 🎁');
  });
  $('btn-balance').addEventListener('click', () => { unlockAudio(); });
  $('btn-game-cards').addEventListener('click', () => {
    unlockAudio();
    toast('Game cards coming soon! 🃏');
  });

  // Member center: betting record / P&L / my bids
  $('btn-betting-record').addEventListener('click', () => { unlockAudio(); showRecord('bets'); });
  $('btn-profit-loss').addEventListener('click', () => { unlockAudio(); showRecord('pnl'); });
  $('btn-my-bids').addEventListener('click', () => { unlockAudio(); showRecord('bets'); });
  $('btn-record-close').addEventListener('click', () => { $('record-panel').hidden = true; });

  // Name editing
  $('btn-edit-name').addEventListener('click', () => {
    unlockAudio();
    $('name-input').value = $('profile-name').textContent === '–' ? '' : $('profile-name').textContent;
    $('name-edit-row').hidden = false;
    $('name-input').focus();
  });
  $('btn-save-name').addEventListener('click', saveName);
  $('btn-cancel-name').addEventListener('click', () => { $('name-edit-row').hidden = true; });

  // Avatar picker
  buildAvatarGrid();
  $('btn-edit-avatar').addEventListener('click', () => {
    unlockAudio();
    $('avatar-picker').hidden = false;
  });
  $('btn-cancel-avatar').addEventListener('click', () => { $('avatar-picker').hidden = true; });
}
