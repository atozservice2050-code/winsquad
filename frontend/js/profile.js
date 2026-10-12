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
    const { error } = await supabase.from('profiles')
      .update({ avatar: emoji })
      .eq('id', currentUserId);
    if (error) throw error;
    $('profile-avatar').textContent = emoji;
    $('avatar-picker').hidden = true;
    toast('Avatar updated! ' + emoji);
  } catch (e) {
    console.warn('avatar save failed', e);
    toast('Could not save avatar', true);
  }
}

async function saveName() {
  const input = $('name-input');
  const name = input.value.trim();
  if (!name) { toast('Enter a name', true); return; }
  if (!currentUserId) { toast('Not signed in', true); return; }
  try {
    const { error } = await supabase.from('profiles')
      .update({ display_name: name })
      .eq('id', currentUserId);
    if (error) throw error;
    $('profile-name').textContent = name;
    $('name-edit-row').hidden = true;
    toast('Name updated!');
  } catch (e) {
    console.warn('name save failed', e);
    toast('Could not save name', true);
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
