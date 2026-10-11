/* ============================================================
   PROFILE — display name, phone, referral ID (WS-######),
   14-digit numeric transfer ID, copy buttons, logout.
   ============================================================ */
import { $, copyText, unlockAudio } from './util.js';
import { logout } from './auth.js';

export function renderProfile(profile, phone) {
  $('profile-name').textContent = profile?.display_name || '–';
  $('profile-phone').textContent = phone || profile?.phone || '–';
  $('profile-referral').textContent = profile?.referral_id || '–';
  $('profile-transfer').textContent = profile?.transfer_id || '–';
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
}
