/* ============================================================
   Session backup — keeps the user logged in even if the
   WebView/APK wrapper wipes localStorage.

   The Supabase auth token is duplicated into two places:
     1. a 30-day cookie:        winsquad_sb_backup
     2. a second localStorage key: winsquad_session_backup

   On app start, restoreSession() copies a surviving backup back
   into the Supabase storage key BEFORE the first getSession(),
   so the session survives a storage wipe.

   Security: this stores the SAME auth token Supabase already
   keeps in localStorage — no new secrets, never passwords.
   Manual logout clears the backup too (SIGNED_OUT event).
   ============================================================ */

import { supabase } from './supabase-client.js';

const BACKUP_COOKIE = 'winsquad_sb_backup';
const BACKUP_LS_KEY = 'winsquad_session_backup';
const BACKUP_KEY_NAME = 'winsquad_session_backup_key';
const COOKIE_MAX_AGE = 2592000; // 30 days in seconds

/** Find the live Supabase auth-token storage key in localStorage. */
function findSbKey() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('sb-') === 0 && k.slice(-11) === '-auth-token') return k;
    }
  } catch (_) { /* storage unavailable */ }
  return null;
}

/** Reconstruct the sb- key from a session blob's JWT issuer (project ref). */
function keyFromSessionJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    const jwt = parsed && parsed.access_token;
    if (!jwt || jwt.split('.').length !== 3) return null;
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const iss = payload.iss || '';
    const m = iss.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
    return m ? 'sb-' + m[1] + '-auth-token' : null;
  } catch (_) {
    return null;
  }
}

function readCookie(name) {
  try {
    const parts = document.cookie.split(';');
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i].trim();
      if (c.indexOf(name + '=') === 0) return decodeURIComponent(c.slice(name.length + 1));
    }
  } catch (_) { /* no document/cookies */ }
  return null;
}

function writeCookie(name, value) {
  try {
    document.cookie = name + '=' + encodeURIComponent(value) +
      '; max-age=' + COOKIE_MAX_AGE + '; path=/; SameSite=Lax';
  } catch (_) { /* cookies blocked */ }
}

function deleteCookie(name) {
  try {
    document.cookie = name + '=; max-age=0; path=/; SameSite=Lax';
  } catch (_) { /* ignore */ }
}

function looksLikeSession(raw) {
  return typeof raw === 'string' && raw.indexOf('access_token') !== -1;
}

/** Copy the current Supabase session into the cookie + backup key. */
export function backupSession() {
  try {
    const sbKey = findSbKey();
    if (!sbKey) return;
    const raw = localStorage.getItem(sbKey);
    if (!looksLikeSession(raw)) return;
    writeCookie(BACKUP_COOKIE, raw);
    try {
      localStorage.setItem(BACKUP_LS_KEY, raw);
      localStorage.setItem(BACKUP_KEY_NAME, sbKey);
    } catch (_) { /* quota/private mode */ }
  } catch (_) { /* ignore */ }
}

/** Remove every backup (called on sign-out). */
export function clearSessionBackup() {
  deleteCookie(BACKUP_COOKIE);
  try {
    localStorage.removeItem(BACKUP_LS_KEY);
    localStorage.removeItem(BACKUP_KEY_NAME);
  } catch (_) { /* ignore */ }
}

/**
 * Restore a backed-up session into the Supabase storage key.
 * MUST run BEFORE the first getSession() in boot().
 * Returns true when a backup was restored.
 */
export function restoreSession() {
  try {
    // If Supabase already holds a live token, nothing to do.
    const liveKey = findSbKey();
    if (liveKey && looksLikeSession(localStorage.getItem(liveKey))) return false;

    const raw = readCookie(BACKUP_COOKIE) ||
      (function () { try { return localStorage.getItem(BACKUP_LS_KEY); } catch (_) { return null; } })();
    if (!looksLikeSession(raw)) return false;

    let key = liveKey;
    if (!key) {
      try { key = localStorage.getItem(BACKUP_KEY_NAME); } catch (_) { /* ignore */ }
    }
    if (!key || key.indexOf('sb-') !== 0) key = keyFromSessionJson(raw);
    if (!key) return false;

    localStorage.setItem(key, raw);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Wire auth events: TOKEN_REFRESHED/SIGNED_IN -> re-backup,
 * SIGNED_OUT -> clear the backup. Idempotent.
 */
let _wired = false;
export function initSessionBackup() {
  if (_wired) return;
  _wired = true;
  try {
    if (!supabase || !supabase.auth || typeof supabase.auth.onAuthStateChange !== 'function') return;
    supabase.auth.onAuthStateChange(function (event) {
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
        // Small delay so Supabase finishes writing the new token first.
        setTimeout(backupSession, 500);
      } else if (event === 'SIGNED_OUT') {
        clearSessionBackup();
      }
    });
  } catch (_) { /* ignore */ }
}
