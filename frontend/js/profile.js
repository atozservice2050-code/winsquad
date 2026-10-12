/* ============================================================
   PROFILE — display name, phone, referral ID (WS-######),
   14-digit numeric transfer ID, copy buttons, logout.
   Users can change their display name and emoji avatar.
   ============================================================ */
import { $, copyText, unlockAudio, toast } from './util.js';
import { logout } from './auth.js';
import { supabase } from './supabase-client.js';

const AVATARS = ['😎','🦁','🐯','🦊','🐼','🐨','🦄','🐸','🐵','🐙','🦋','🐝','🦖','🐳','🍀','⚡','🔥','💎','👑','🎯','🚀','🌟'];

let currentUserId = null;

export function renderProfile(profile, phone) {
  $('profile-name').textContent = profile?.display_name || '–';
  $('profile-phone').textContent = phone || profile?.phone || '–';
  $('profile-referral').textContent = profile?.referral_id || '–';
  $('profile-transfer').textContent = profile?.transfer_id || '–';
  $('profile-avatar').textContent = profile?.avatar || '😎';
  if (profile?.id) currentUserId = profile.id;
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
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      unlockAudio();
      const target = $(btn.dataset.copy);
      copyText(target.textContent.trim(), 'Copied!');
    });
  });
  $('btn-logout').addEventListener('click', async () => {
    if (confirm('Log out of WinSquad?')) await logout();
  });

  // Admin portal button (only for admins)
  $('btn-admin-portal').addEventListener('click', () => {
    window.open('/admin', '_blank');
  });
  checkAdminAccess();

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
