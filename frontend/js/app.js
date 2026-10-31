/* ============================================================
   WinSquad frontend — boot, view router, session handling.
   Single-page app: auth -> (setup) -> arena / private / wallet /
   rewards / profile. Bottom tab bar navigates; each view module
   owns its own logic. Realtime subscriptions live in the modules.
   ============================================================ */
import { ENV_OK, ENV_ERROR, supabase } from './supabase-client.js';
import { $, toast, unlockAudio } from './util.js';
import { initNotifications } from './notifications.js';
import { initAuth, initSetup, initResetPassword, isRecoveryUrl, loadProfile } from './auth.js';
import { initArena, destroyArena, setUser as setArenaUser } from './arena.js';
import { initPrivate, destroyPrivate, joinPrivateTableByCode, setUser as setPrivateUser } from './private.js?v=53';
import { initWallet, refreshWallet, setUser as setWalletUser, initWalletTopbar } from './wallet.js';
import { initRewards, refreshRewards, setUser as setRewardsUser } from './rewards.js';
import { initProfile, renderProfile } from './profile.js';
import { initCoinflip, setUser as setCoinflipUser, destroyCoinflip } from './coinflip.js';
import { initAndarBahar, setUser as setAndarBaharUser, destroyAndarBahar } from './ab.js';
import { initDT, setUser as setDTUser, destroyDT } from './dt.js';
import { initRoulette, setUser as setRouletteUser, destroyRoulette } from './roulette.js';
import { initCashvault, setUser as setCashvaultUser, destroyCashvault } from './cashvault.js';
import { initDice, setUser as setDiceUser, destroyDice } from './dice.js';
import { initDisclaimer, maybeShowDisclaimer } from './disclaimer.js';
import { initMissions, refreshMissions, setUser as setMissionsUser, recordMissionEvent } from './missions.js';
import { initFreeGames, refreshFreeHub, setUser as setFreeUser } from './free-games.js?v=49';
import { restoreSession, initSessionBackup } from './session-backup.js';

const VIEWS = ['auth', 'setup', 'resetpw', 'home', 'arena', 'private', 'wallet', 'rewards', 'missions', 'profile', 'coinflip', 'andarbahar', 'dt', 'roulette', 'cashvault', 'dice', 'freehub', 'mines', 'memory', 'flappy'];
const TAB_VIEWS = ['home', 'arena', 'private', 'wallet', 'rewards', 'missions', 'profile'];
let currentView = null;
let currentProfile = null;
let initialized = {};
const PRIVATE_INVITE_KEY = 'winsquad_pending_private_invite';
let privateInviteHandled = false;

function capturePrivateInvite() {
  try {
    const params = new URLSearchParams(location.search);
    const raw = params.get('join') || params.get('invite');
    if (!raw) return;
    const code = raw.trim().toUpperCase();
    if (/^[A-Z0-9-]{4,12}$/.test(code)) localStorage.setItem(PRIVATE_INVITE_KEY, code);
    params.delete('join');
    params.delete('invite');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  } catch (_) {}
}

async function handlePendingPrivateInvite() {
  if (privateInviteHandled) return;
  let code = '';
  try { code = localStorage.getItem(PRIVATE_INVITE_KEY) || ''; } catch (_) {}
  if (!code) return;
  privateInviteHandled = true;
  try { localStorage.removeItem(PRIVATE_INVITE_KEY); } catch (_) {}
  showView('private');
  await joinPrivateTableByCode(code);
}

/* ---------------- router ----------------
   Resume behaviour (owner order): the app must reopen where the
   player left it — no refresh back to the hub. Every navigation is
   (a) remembered in localStorage and restored on the next launch,
   and (b) pushed onto the browser history, so the Android Back
   button steps back through views instead of closing the app. */
const LAST_VIEW_KEY = 'winsquad_last_view';
const NO_RESTORE_VIEWS = ['auth', 'setup', 'resetpw'];
let navFromPop = false;
window.addEventListener('popstate', (e) => {
  const v = e && e.state && e.state.view;
  if (v && VIEWS.includes(v) && v !== currentView) {
    navFromPop = true;
    showView(v);
    navFromPop = false;
  }
});

function showView(name) {
  if (!VIEWS.includes(name)) name = 'home';
  const prevView = currentView;
  currentView = name;
  if (!NO_RESTORE_VIEWS.includes(name)) {
    try { localStorage.setItem(LAST_VIEW_KEY, name); } catch (e) {}
    if (!navFromPop && prevView && prevView !== name && !NO_RESTORE_VIEWS.includes(prevView)) {
      try { history.pushState({ view: name }, ''); } catch (e) {}
    }
  }
  // Hide splash screen on first view render.
  const splash = document.getElementById('splash');
  if (splash && !splash.classList.contains('hide')) {
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 600);
  }
  // Null-safe: skip views whose section is missing from the DOM (never crash).
  VIEWS.forEach(v => {
    const el = $('view-' + v);
    if (el) el.hidden = v !== name;
    else if (v === name) console.warn('showView: missing section for view "' + v + '"');
  });

  // Full-screen play mode: in a game, the tab bar AND top bar hide so
  // the whole screen is the game; Back (← Games) returns to the menu.
  const GAME_VIEWS = ['arena', 'coinflip', 'andarbahar', 'dt', 'roulette', 'cashvault', 'dice', 'mines', 'memory', 'flappy'];
  const inGame = GAME_VIEWS.includes(name);
  const inTabs = !inGame && TAB_VIEWS.includes(name);
  const activeTab = name;
  $('tabbar').hidden = !inTabs;
  $('topbar').style.display = inTabs ? 'flex' : 'none';
  document.body.classList.toggle('has-tabs', inTabs);
  document.body.classList.toggle('playing', inGame);
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === activeTab));

  window.scrollTo(0, 0);

  // Lazy init + refresh per view
  if (name === 'arena' && !initialized.arena) { initArena(); initialized.arena = true; }
  if (name === 'private' && !initialized.private) { initPrivate(); initialized.private = true; }
  if (name === 'wallet' && !initialized.wallet) { initWallet(); initialized.wallet = true; }
  if (name === 'rewards' && !initialized.rewards) { initRewards(); initialized.rewards = true; }
  if (name === 'missions' && !initialized.missions) { initMissions(); initialized.missions = true; }
  if (name === 'profile' && !initialized.profile) { initProfile(); initialized.profile = true; }

  if (name === 'wallet') refreshWallet();
  if (name === 'rewards') refreshRewards(currentProfile?.referral_id);
  if (name === 'missions') refreshMissions();
  if (name === 'profile') renderProfile(currentProfile);
  if (name === 'coinflip' && !initialized.coinflip) { initCoinflip(); initialized.coinflip = true; }
  if (name === 'andarbahar' && !initialized.andarbahar) { initAndarBahar(); initialized.andarbahar = true; }
  if (name === 'dt' && !initialized.dt) { initDT(); initialized.dt = true; }
  if (name === 'roulette' && !initialized.roulette) { initRoulette(); initialized.roulette = true; }
  if (name === 'cashvault' && !initialized.cashvault) { initCashvault(); initialized.cashvault = true; }
  if (name === 'dice' && !initialized.dice) { initDice(); initialized.dice = true; }
  if (name === 'freehub') { try { refreshFreeHub(); } catch (e) {} }
  if (name === 'arena' && initialized.arena) { /* arena runs its own realtime loop */ }
}

/* Push notifications (APK v2+): the native shell exposes
   window.WinSquadPush; register this device's FCM token against the
   signed-in user, and nag users on an outdated shell to update. */
const LATEST_APK_VERSION = 4;
function initPushBridge() {
  const bridge = window.WinSquadPush;
  if (!bridge) return; // plain web browser — no native push
  const send = (t) => {
    if (t) supabase.rpc('register_push_token', { p_token: t, p_platform: 'android' }).then(() => {}, () => {});
  };
  try { send(bridge.getToken()); } catch (e) {}
  window.addEventListener('winsquad-push-token', (e) => send(e.detail));
  try {
    const vc = bridge.getVersionCode();
    if (vc && vc < LATEST_APK_VERSION) {
      const banner = $('apk-update-banner');
      if (banner) {
        banner.hidden = false;
        $('apk-update-close')?.addEventListener('click', () => { banner.hidden = true; });
      }
    }
  } catch (e) {}
}

/* Presence heartbeat: keeps profiles.last_seen_at fresh so the admin
   portal can show who is online (migration 033). */
let presenceTimer = null;
function startPresence() {
  const beat = () => { supabase.rpc('touch_presence').then(() => {}, () => {}); };
  beat();
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = setInterval(beat, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
}

function enterApp(profile, phone) {
  currentProfile = profile;
  const uid = profile?.id;
  setArenaUser(uid);
  setPrivateUser(uid, profile?.display_name);
  setWalletUser(uid);
  setRewardsUser(uid);
  setMissionsUser(uid);
  setCoinflipUser(uid);
  setAndarBaharUser(uid);
  setDTUser(uid);
  setRouletteUser(uid);
  setCashvaultUser(uid);
  setDiceUser(uid);
  setFreeUser(uid);
  initWalletTopbar();
  startPresence();
  initPushBridge();
  $('app').hidden = false;
  // Reopen where the player left off (not a refresh to the hub).
  let startView = 'home';
  try {
    const lv = localStorage.getItem(LAST_VIEW_KEY);
    if (lv && VIEWS.includes(lv) && !NO_RESTORE_VIEWS.includes(lv)) startView = lv;
  } catch (e) {}
  showView(startView);
  try { history.replaceState({ view: startView }, ''); } catch (e) {}
  // Disclaimer: shown once on first login.
  try { maybeShowDisclaimer(); } catch (e) {}
  // Mission progress: daily visit
  try { recordMissionEvent('daily_visit'); } catch (e) {}
  // A shared private-table link opens that table directly after login.
  try { handlePendingPrivateInvite(); } catch (e) { console.warn('private invite failed', e); }
}

/* ---------------- boot ---------------- */
async function boot() {
  capturePrivateInvite();
  initNotifications();
  initDisclaimer();
  try { initFreeGames(showView); } catch (e) { console.warn('free games init failed', e); }
  // 0. Session backup: restore a wiped session BEFORE the first
  // getSession(), and keep the backup fresh on token refresh.
  // (The APK WebView can clear localStorage between launches.)
  try { restoreSession(); } catch (_) {}
  try { initSessionBackup(); } catch (_) {}
  // 1. Backend config present?
  if (!ENV_OK) {
    console.error(ENV_ERROR);
    $('setup-error').hidden = false;
    return;
  }
  // Config OK — make sure the setup card stays hidden.
  $('setup-error').hidden = true;

  // 1b. Forced logout? (?logout=1 clears the session — escape hatch)
  try {
    if (new URLSearchParams(location.search).has('logout')) {
      try { await supabase.auth.signOut(); } catch (_) {}
      try {
        Object.keys(localStorage).forEach(k => {
          if (k.startsWith('sb-')) localStorage.removeItem(k);
        });
      } catch (_) {}
      location.href = location.pathname;
      return;
    }
  } catch (_) {}

  // 2. Password-recovery link? (user tapped the email link)
  // detectSessionInUrl exchanges the ?code= automatically inside getSession().
  if (isRecoveryUrl()) {
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        $('app').hidden = false;
        // Clean the recovery params out of the address bar.
        try { history.replaceState(null, '', location.pathname); } catch (_) {}
        showView('resetpw');
        initResetPassword();
        return;
      }
    } catch (e) {
      console.warn('recovery session failed', e);
    }
    // Recovery link invalid/expired — fall through to normal login.
    toast('Recovery link expired. Request a new one below.', true);
  }

  // 3. Existing session?
  let session = null;
  try {
    const { data } = await supabase.auth.getSession();
    session = data.session;
  } catch (e) {
    console.warn('getSession failed', e);
  }

  initAuth(async () => {
    // Called after successful login.
    try {
      const { user, profile } = await loadProfile();
      // Blocked by admin? Sign out immediately.
      if (profile && profile.is_blocked) {
        try { await supabase.auth.signOut(); } catch (_) {}
        $('app').hidden = false;
        showView('login');
        toast('Your account has been blocked. Contact support.', true);
        return;
      }
      if (!profile || !profile.display_name) {
        $('app').hidden = false;
        showView('setup');
        initSetup(() => location.reload());
      } else {
        enterApp({ ...profile, id: user.id }, user.phone);
      }
    } catch (e) {
      console.warn('post-auth profile load failed, entering with minimal profile', e);
      // Don't block the user - enter app with minimal data, profile will load in background
      try {
        const { data } = await supabase.auth.getUser();
        const user = data?.user;
        if (user) {
          // Enter with minimal profile - screens will load their own data
          enterApp({ id: user.id, display_name: 'Player' }, user.phone || '');
          toast('Profile loading in background...', false);
          // Retry profile load in background
          setTimeout(async () => {
            try {
              const { profile } = await loadProfile();
              if (profile?.display_name) {
                location.reload(); // Reload with full profile
              }
            } catch (_) {}
          }, 3000);
        } else {
          throw e;
        }
      } catch (e2) {
        const msg = e?.message || 'unknown';
        toast('Profile error: ' + msg, true);
        setTimeout(() => location.reload(), 3000);
      }
    }
  });

  if (session?.user) {
    try {
      const { user, profile } = await loadProfile();
      // Blocked by admin? Sign out immediately.
      if (profile && profile.is_blocked) {
        try { await supabase.auth.signOut(); } catch (_) {}
        $('app').hidden = false;
        showView('login');
        toast('Your account has been blocked. Contact support.', true);
        return;
      }
      if (!profile || !profile.display_name) {
        $('app').hidden = false;
        showView('setup');
        initSetup(() => location.reload());
      } else {
        enterApp({ ...profile, id: user.id }, user.phone);
      }
    } catch (e) {
      console.warn('boot profile load failed, entering with minimal profile', e);
      // Don't bounce the user to login — enter with minimal data, retry in background.
      const user = session.user;
      enterApp({ id: user.id, display_name: 'Player' }, user.phone || '');
      const msg = e?.message || e?.error_description || 'unknown';
      toast('Profile sync issue (' + String(msg).slice(0, 80) + ') — retrying…', true);
      setTimeout(async () => {
        try {
          const { profile } = await loadProfile();
          if (profile?.display_name) location.reload();
        } catch (_) {}
      }, 4000);
    }
  } else {
    $('app').hidden = false;
    showView('auth');
  }

  // Keep UI in sync if the session dies (e.g. token revoked).
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      destroyArena();
      destroyPrivate();
      destroyCoinflip();
      destroyAndarBahar();
      destroyDT();
      destroyRoulette();
      location.reload();
    }
  });
}

/* Web-only elements (app download option): hidden inside the APK shell. */
if (window.WinSquadPush) document.body.classList.add('in-apk');
else {
  try {
    if (!localStorage.getItem('winsquad_dl_dismissed')) {
      const bar = $('dl-bar');
      if (bar) bar.hidden = false;
    }
  } catch (e) {}
  $('dl-bar-close')?.addEventListener('click', () => {
    const bar = $('dl-bar');
    if (bar) bar.hidden = true;
    try { localStorage.setItem('winsquad_dl_dismissed', '1'); } catch (e) {}
  });
}

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => showView(t.dataset.view)));

/* Generic in-app navigation: any element with data-open-view="x" opens view x. */
document.querySelectorAll('[data-open-view]').forEach(b =>
  b.addEventListener('click', () => { unlockAudio(); showView(b.dataset.openView); }));

/* Global logout: attached at startup (not in initProfile) so it always works. */
document.addEventListener('click', async (e) => {
  const btn = e.target?.closest?.('#btn-logout');
  if (!btn) return;
  e.preventDefault();
  try {
    const { logout } = await import('./auth.js');
    await logout();
  } catch (err) {
    console.warn('global logout failed', err);
    try { location.href = location.pathname + '?logout=1'; } catch (_) {}
  }
});

/* Games hub: playable games open their views; others are coming soon. */
document.querySelectorAll('.game-card').forEach(c =>
  c.addEventListener('click', () => {
    if (c.dataset.game === 'squad') {
      showView('arena');
    } else if (c.dataset.game === 'coinflip') {
      showView('coinflip');
    } else if (c.dataset.game === 'andarbahar') {
      showView('andarbahar');
    } else if (c.dataset.game === 'dragontiger') {
      showView('dt');
    } else if (c.dataset.game === 'roulette') {
      showView('roulette');
    } else if (c.dataset.game === 'cashvault') {
      showView('cashvault');
    } else if (c.dataset.game === 'dice') {
      showView('dice');
    } else if (c.dataset.game === 'freehub') {
      showView('freehub');
    } else {
      toast('Coming soon! 🎮');
    }
  }));

boot();
