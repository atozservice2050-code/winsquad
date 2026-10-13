/* ============================================================
   Auth: phone number + password (no SMS OTP).
   We derive a deterministic internal email from the phone number
   (e.g. 923001234567@winsquad.app) and use Supabase email+password
   auth under the hood. The real phone number is stored in the
   profiles table. Email (optional, for recovery) is stored too.
   After sign-in, profiles row is checked: if it has no display
   name, the user is sent to first-time profile setup. The backend
   trigger creates referral_id (WS-######) and the 14-digit
   transfer_id when the profile row is created.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, toast, normalizePhone, unlockAudio } from './util.js';

let mode = 'login'; // 'login' | 'signup'

/** Convert a normalized PK phone (e.g. 923001234567) to internal email.
 *  Uses Gmail plus-addressing so each phone maps to a unique, valid email. */
function phoneToEmail(phone) {
  const digits = phone.replace(/\D/g, '');
  return `atozservice2050+${digits}@gmail.com`;
}

/** Detect where the user is signing up from: the APK (Android WebView),
 *  a mobile browser, or desktop web — so the owner can compare platforms. */
function detectDeviceSource() {
  const ua = navigator.userAgent || '';
  if (ua.indexOf('; wv)') !== -1 || /\bwv\b/.test(ua)) return 'apk';
  if (/Mobi|Android|iPhone|iPad|Mobile/i.test(ua)) return 'mobile-web';
  return 'desktop-web';
}

function showError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.hidden = false;
}

function setMode(next) {
  mode = next;
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-signup').classList.toggle('active', mode === 'signup');
  $('signup-email-wrap').hidden = mode !== 'signup';
  $('btn-auth-go').textContent = mode === 'login' ? 'Login & play' : 'Create account';
  $('auth-hint').textContent = mode === 'login'
    ? 'Enter your mobile number and password.'
    : 'Choose a password (min 6 characters).';
  $('auth-error').hidden = true;
  const forgot = $('btn-forgot');
  if (forgot) forgot.hidden = mode !== 'login';
}

/** True when the URL carries a Supabase recovery token (?code= PKCE or #type=recovery). */
export function isRecoveryUrl() {
  try {
    if (new URLSearchParams(location.search).has('code')) return true;
  } catch (_) {}
  return (location.hash || '').includes('type=recovery');
}

/** Wire the "Set new password" view shown after tapping the recovery email link. */
export function initResetPassword() {
  const go = $('btn-resetpw-go');
  if (!go || go.dataset.wired) return;
  go.dataset.wired = '1';
  const errEl = $('resetpw-error');
  const okEl = $('resetpw-ok');
  const showErr = (m) => { errEl.textContent = m; errEl.hidden = false; };
  go.addEventListener('click', async () => {
    errEl.hidden = true; okEl.hidden = true;
    const pw = $('resetpw-input').value;
    if (!pw || pw.length < 6) { showErr('Password must be at least 6 characters.'); return; }
    go.disabled = true;
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      okEl.textContent = 'Password updated! Redirecting to login…';
      okEl.hidden = false;
      setTimeout(() => { location.href = location.pathname; }, 1500);
    } catch (e) {
      showErr(e?.message || 'Could not update password. The link may have expired.');
    } finally {
      go.disabled = false;
    }
  });
}

export function initAuth(onAuthed) {
  $('tab-login').addEventListener('click', () => setMode('login'));
  $('tab-signup').addEventListener('click', () => setMode('signup'));

  $('btn-auth-go').addEventListener('click', async () => {
    unlockAudio();
    const phone = normalizePhone($('phone-input').value);
    if (!phone) { showError('Enter a valid Pakistani mobile number (e.g. 0300 1234567).'); return; }
    const password = $('password-input').value;
    if (!password || password.length < 6) { showError('Password must be at least 6 characters.'); return; }

    $('auth-error').hidden = true;
    $('btn-auth-go').disabled = true;
    try {
      const email = phoneToEmail(phone);
      if (mode === 'signup') {
        const recoveryEmail = $('email-input').value.trim();
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { phone, recovery_email: recoveryEmail || null, device_source: detectDeviceSource() },
          },
        });
        if (error) throw error;
        // Ensure profile row has the real phone number.
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await supabase.from('profiles').upsert(
            { id: user.id, phone },
            { onConflict: 'id' }
          );
        }
        toast('Account created — welcome!');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // Ensure session is fully established before loading profile
        // (avoids race where getUser() runs before auth state updates).
        await supabase.auth.getSession();
      }
      onAuthed();
    } catch (e) {
      showError(friendlyError(e, mode === 'signup' ? 'Could not create account. Try again.' : 'Login failed. Check your number and password.'));
    } finally {
      $('btn-auth-go').disabled = false;
    }
  });

  // Enter key submits.
  $('password-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-auth-go').click();
  });

  // Forgot password? — email a recovery link to the account's login email.
  const forgot = $('btn-forgot');
  if (forgot) {
    forgot.addEventListener('click', async () => {
      const phone = normalizePhone($('phone-input').value);
      if (!phone) { showError('Enter your mobile number first, then tap Forgot password?'); return; }
      forgot.disabled = true;
      try {
        const email = phoneToEmail(phone);
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + location.pathname,
        });
        if (error) throw error;
        toast('Recovery email sent! Check your inbox and tap the link.', false);
      } catch (e) {
        showError(e?.message || 'Could not send recovery email. Try again.');
      } finally {
        forgot.disabled = false;
      }
    });
  }
}

/** Load the current user's profile row (created by backend trigger on signup). */
export async function loadProfile() {
  // Retry getUser once — after signIn the session can take a moment to settle.
  let user = null;
  for (let i = 0; i < 3; i++) {
    const { data } = await supabase.auth.getUser();
    if (data?.user) { user = data.user; break; }
    await new Promise(r => setTimeout(r, 400));
  }
  if (!user) return { user: null, profile: null };
  
  // Use secure RPC to fetch profile (bypasses RLS issues)
  try {
    const { data, error } = await supabase.rpc('get_my_profile');
    if (error) throw error;
    const result = unwrapRow(data);
    if (result?.ok && result?.profile) {
      return { user, profile: result.profile };
    }
  } catch (e) {
    console.warn('get_my_profile RPC failed, falling back to direct query', e);
  }
  
  // Fallback: direct query (original method)
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  return { user, profile: unwrapRow(data) };
}

/** First-login setup: display name (+ optional referral code). */
export function initSetup(onDone) {
  $('btn-setup-save').addEventListener('click', async () => {
    const name = $('setup-name').value.trim();
    if (name.length < 2) {
      $('setup-error-msg').textContent = 'Pick a display name (at least 2 characters).';
      $('setup-error-msg').hidden = false;
      return;
    }
    $('setup-error-msg').hidden = true;
    $('btn-setup-save').disabled = true;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const updates = { id: user.id, display_name: name };
      const { error } = await supabase.from('profiles').upsert(updates, { onConflict: 'id' });
      if (error) throw error;

      // Optional referral code — backend applies the Rs 100 both-sides bonus.
      const code = $('setup-referral').value.trim().toUpperCase();
      if (code) {
        try {
          const { data, error: refErr } = await supabase.rpc('apply_referral', { p_referral_id: code });
          const row = unwrapRow(data);
          if (refErr || (row && row.ok === false)) throw refErr || new Error(row.error);
          toast('Referral applied — Rs 100 for you, Rs 500 for inviter! 🎉');
        } catch (e) {
          toast('Name saved, but referral code was not accepted.', true);
        }
      }
      onDone();
    } catch (e) {
      $('setup-error-msg').textContent = friendlyError(e, 'Could not save. Try again.');
      $('setup-error-msg').hidden = false;
    } finally {
      $('btn-setup-save').disabled = false;
    }
  }, { once: false });
}

export async function logout() {
  await supabase.auth.signOut();
  location.reload();
}
