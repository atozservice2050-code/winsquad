/* ============================================================
   PROFILE — b9-style MY ACCOUNT: gold card, VIP level, member
   center grid, betting record, profit/loss. Keeps display name,
   phone, referral ID, 14-digit transfer ID, copy, logout, admin.
   ============================================================ */
import { $, copyText, shareInvite, unlockAudio, toast, fmtRs, isSoundOn, setSoundOn } from './util.js';
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

/* Betting record / Profit & Loss panel.
   Reads EVERY game's bid table. (The old version read only the legacy
   Arena table and cf_bids — and asked cf_bids for a created_at column
   it does not have — so Roulette / Dragon Tiger / Andar Bahar / Dice /
   Cash Vault / Private players saw an empty record.) */
const BID_SOURCES = [
  { table: 'roulette_bids', game: 'Roulette', cols: 'amount, placed_at, is_winner, payout, bet_type, bet_value',
    pick: b => b.bet_type === 'straight' ? 'No. ' + b.bet_value : b.bet_type },
  { table: 'cf_bids', game: 'Coin Flip', cols: 'amount, placed_at, is_winner, payout, side', pick: b => b.side },
  { table: 'dt_bids', game: 'Dragon Tiger', cols: 'amount, placed_at, is_winner, payout, side', pick: b => b.side },
  { table: 'ab_bids', game: 'Andar Bahar', cols: 'amount, placed_at, is_winner, payout, side', pick: b => b.side },
  { table: 'dice_bids', game: 'Dice · 7 Up Down', cols: 'amount, placed_at, is_winner, payout, option',
    pick: b => ({ under7: 'Under 7', seven: 'Exactly 7', over7: 'Over 7' })[b.option] || b.option },
  { table: 'cv_bids', game: 'Cash Vault', cols: 'amount, placed_at, is_winner, payout, segment', pick: b => b.segment },
  { table: 'private_bids', game: 'Private Table', cols: 'amount, placed_at, round_no', pick: b => 'Round ' + b.round_no },
  { table: 'bids', game: 'Arena', cols: 'amount, placed_at', pick: () => '' },
];

async function loadAllBids() {
  const out = [];
  await Promise.all(BID_SOURCES.map(async (src) => {
    try {
      const { data, error } = await supabase.from(src.table)
        .select(src.cols).eq('user_id', currentUserId)
        .order('placed_at', { ascending: false }).limit(30);
      if (error) { console.warn('record source failed', src.table, error); return; }
      (data || []).forEach(b => out.push({
        game: src.game, pick: src.pick(b), amount: Number(b.amount || 0),
        at: b.placed_at,
        isWinner: (b.is_winner === undefined ? null : b.is_winner),
        payout: b.payout != null ? Number(b.payout) : null,
      }));
    } catch (e) { console.warn('record source failed', src.table, e); }
  }));
  out.sort((a, b) => new Date(b.at) - new Date(a.at));
  return out;
}

async function showRecord(kind) {
  const panel = $('record-panel');
  const list = $('record-list');
  $('record-title').textContent = kind === 'pnl' ? '📈 Profit & Loss' : '📊 Betting Record';
  panel.hidden = false;
  list.innerHTML = '<p class="hint">Loading…</p>';
  if (!currentUserId) { list.innerHTML = '<p class="hint">Not signed in.</p>'; return; }
  try {
    const rows = await loadAllBids();
    if (kind === 'pnl') {
      let wagered = 0, returned = 0, pending = 0;
      rows.forEach(r => {
        wagered += r.amount;
        if (r.isWinner === true) returned += (r.payout || 0);
        else if (r.isWinner === null) pending += 1;
      });
      const net = returned - wagered;
      list.innerHTML =
        '<div class="profile-row"><span>Total wagered</span><strong>Rs ' + fmtRs(wagered) + '</strong></div>' +
        '<div class="profile-row"><span>Total returned</span><strong style="color:#2ee06f">Rs ' + fmtRs(returned) + '</strong></div>' +
        '<div class="profile-row"><span>Net P&amp;L</span><strong style="color:' + (net >= 0 ? '#2ee06f' : '#ff5555') + '">Rs ' + fmtRs(net) + '</strong></div>' +
        (pending ? '<p class="hint">⏳ ' + pending + ' bet(s) still playing — P&amp;L updates when those rounds finish.</p>' : '');
    } else {
      if (!rows.length) { list.innerHTML = '<p class="hint">No bets yet — play any game and your bets will show here.</p>'; return; }
      list.innerHTML = rows.slice(0, 20).map(r => {
        const when = r.at ? new Date(r.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
        const res = r.isWinner === true
          ? '<strong style="color:#2ee06f">🏆 +Rs ' + fmtRs(r.payout || 0) + '</strong>'
          : r.isWinner === false
            ? '<strong style="color:#ff5555">😭 lost</strong>'
            : '<strong>⏳ playing</strong>';
        return '<div class="profile-row"><span>' + r.game + (r.pick ? ' · ' + r.pick : '') +
          '<br><small class="muted">' + when + '</small></span>' +
          '<span style="text-align:right">Rs ' + fmtRs(r.amount) + '<br>' + res + '</span></div>';
      }).join('');
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

  // Invite Friends: share sheet with the referral code + app download link.
  on('btn-invite-friends', () => {
    unlockAudio();
    shareInvite(($('profile-referral')?.textContent || '').trim());
  });

  // Sound on/off toggle
  const updateSoundBtn = () => {
    const on = isSoundOn();
    const icon = $('sound-icon'), label = $('sound-label');
    if (icon) icon.textContent = on ? '🔊' : '🔇';
    if (label) label.textContent = on ? 'Sound On' : 'Sound Off';
  };
  on('btn-sound-toggle', () => {
    unlockAudio();
    setSoundOn(!isSoundOn());
    updateSoundBtn();
    toast(isSoundOn() ? 'Sound on 🔊' : 'Sound off 🔇');
  });
  updateSoundBtn();

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
    const pw0 = $('pw-current').value;
    const pw1 = $('pw-new').value, pw2 = $('pw-confirm').value;
    if (!pw0) { errEl.textContent = 'Enter your current password first.'; errEl.hidden = false; return; }
    if (!pw1 || pw1.length < 6) { errEl.textContent = 'New password must be at least 6 characters.'; errEl.hidden = false; return; }
    if (pw1 !== pw2) { errEl.textContent = 'Passwords do not match.'; errEl.hidden = false; return; }
    if (pw1 === pw0) { errEl.textContent = 'New password must be different from the current one.'; errEl.hidden = false; return; }
    $('btn-pw-save').disabled = true;
    try {
      // The CURRENT password must check out before anything changes:
      // re-authenticate with it; only a correct one lets us continue.
      const { data: u } = await supabase.auth.getUser();
      const email = u?.user?.email;
      if (!email) throw new Error('Could not verify your account. Please log in again.');
      const { error: vErr } = await supabase.auth.signInWithPassword({ email, password: pw0 });
      if (vErr) { errEl.textContent = 'Current password is incorrect.'; errEl.hidden = false; return; }
      const { error } = await supabase.auth.updateUser({ password: pw1 });
      if (error) throw error;
      $('pw-current').value = ''; $('pw-new').value = ''; $('pw-confirm').value = '';
      okEl.textContent = 'Password changed successfully!';
      okEl.hidden = false;
    } catch (e) {
      errEl.textContent = e?.message || 'Could not change password. Try again.';
      errEl.hidden = false;
    } finally {
      $('btn-pw-save').disabled = false;
    }
  });

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
