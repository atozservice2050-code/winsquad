/* ============================================================
   WinSquad frontend — boot, view router, session handling.
   Single-page app: auth -> (setup) -> arena / private / wallet /
   rewards / profile. Bottom tab bar navigates; each view module
   owns its own logic. Realtime subscriptions live in the modules.
   ============================================================ */
import { ENV_OK, ENV_ERROR, supabase } from './supabase-client.js';
import { $, toast } from './util.js';
import { initAuth, initSetup, loadProfile } from './auth.js';
import { initArena, destroyArena, setUser as setArenaUser } from './arena.js';
import { initPrivate, destroyPrivate, setUser as setPrivateUser } from './private.js';
import { initWallet, refreshWallet, setUser as setWalletUser } from './wallet.js';
import { initRewards, refreshRewards, setUser as setRewardsUser } from './rewards.js';
import { initProfile, renderProfile } from './profile.js';

const VIEWS = ['auth', 'setup', 'arena', 'private', 'wallet', 'rewards', 'profile'];
const TAB_VIEWS = ['arena', 'private', 'wallet', 'rewards', 'profile'];
let currentView = null;
let currentProfile = null;
let initialized = {};

/* ---------------- router ---------------- */
function showView(name) {
  if (!VIEWS.includes(name)) name = 'arena';
  currentView = name;
  VIEWS.forEach(v => { $('view-' + v).hidden = v !== name; });

  const inTabs = TAB_VIEWS.includes(name);
  $('tabbar').hidden = !inTabs;
  $('topbar').style.display = inTabs ? 'flex' : 'none';
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === name));

  window.scrollTo(0, 0);

  // Lazy init + refresh per view
  if (name === 'arena' && !initialized.arena) { initArena(); initialized.arena = true; }
  if (name === 'private' && !initialized.private) { initPrivate(); initialized.private = true; }
  if (name === 'wallet' && !initialized.wallet) { initWallet(); initialized.wallet = true; }
  if (name === 'rewards' && !initialized.rewards) { initRewards(); initialized.rewards = true; }
  if (name === 'profile' && !initialized.profile) { initProfile(); initialized.profile = true; }

  if (name === 'wallet') refreshWallet();
  if (name === 'rewards') refreshRewards(currentProfile?.referral_id);
  if (name === 'profile') renderProfile(currentProfile);
  if (name === 'arena' && initialized.arena) { /* arena runs its own realtime loop */ }
}

function enterApp(profile, phone) {
  currentProfile = profile;
  const uid = profile?.id;
  setArenaUser(uid);
  setPrivateUser(uid, profile?.display_name);
  setWalletUser(uid);
  setRewardsUser(uid);
  $('app').hidden = false;
  showView('arena');
}

/* ---------------- boot ---------------- */
async function boot() {
  // 1. Backend config present?
  if (!ENV_OK) {
    console.error(ENV_ERROR);
    $('setup-error').hidden = false;
    return;
  }

  // 2. Existing session?
  let session = null;
  try {
    const { data } = await supabase.auth.getSession();
    session = data.session;
  } catch (e) {
    console.warn('getSession failed', e);
  }

  initAuth(async () => {
    // Called after successful OTP verification.
    try {
      const { user, profile } = await loadProfile();
      if (!profile || !profile.display_name) {
        $('app').hidden = false;
        showView('setup');
        initSetup(() => location.reload());
      } else {
        enterApp({ ...profile, id: user.id }, user.phone);
      }
    } catch (e) {
      console.warn('post-auth profile load failed', e);
      toast('Signed in, but profile could not load. Reloading…', true);
      setTimeout(() => location.reload(), 1500);
    }
  });

  if (session?.user) {
    try {
      const { user, profile } = await loadProfile();
      if (!profile || !profile.display_name) {
        $('app').hidden = false;
        showView('setup');
        initSetup(() => location.reload());
      } else {
        enterApp({ ...profile, id: user.id }, user.phone);
      }
    } catch (e) {
      console.warn('profile load failed', e);
      toast('Could not load your profile. Check your connection and reload.', true);
      $('app').hidden = false;
      showView('auth');
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
      location.reload();
    }
  });
}

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => showView(t.dataset.view)));

boot();
