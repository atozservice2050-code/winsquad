/* ============================================================
   Auth: phone -> SMS OTP -> verify.
   After sign-in, profiles row is checked: if it has no display
   name, the user is sent to first-time profile setup. The backend
   trigger creates referral_id (WS-######) and the 14-digit
   transfer_id when the profile row is created.
   ============================================================ */
import { supabase, unwrapRow, friendlyError } from './supabase-client.js';
import { $, toast, normalizePhone, unlockAudio } from './util.js';

let pendingPhone = null;

function showError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.hidden = false;
}

export function initAuth(onAuthed) {
  $('btn-send-otp').addEventListener('click', async () => {
    unlockAudio();
    const phone = normalizePhone($('phone-input').value);
    if (!phone) { showError('Enter a valid Pakistani mobile number (e.g. 0300 1234567).'); return; }
    $('auth-error').hidden = true;
    $('btn-send-otp').disabled = true;
    try {
      const { error } = await supabase.auth.signInWithOtp({ phone });
      if (error) throw error;
      pendingPhone = phone;
      $('otp-sent-to').textContent = 'Code sent to ' + phone;
      $('auth-step-phone').hidden = true;
      $('auth-step-otp').hidden = false;
      $('otp-input').focus();
      toast('Code sent by SMS');
    } catch (e) {
      showError(friendlyError(e, 'Could not send the code. Try again.'));
    } finally {
      $('btn-send-otp').disabled = false;
    }
  });

  $('btn-verify-otp').addEventListener('click', async () => {
    const token = $('otp-input').value.trim();
    if (token.length !== 6 || !/^\d{6}$/.test(token)) {
      showError('Enter the 6-digit code from the SMS.');
      return;
    }
    $('auth-error').hidden = true;
    $('btn-verify-otp').disabled = true;
    try {
      const { error } = await supabase.auth.verifyOtp({
        phone: pendingPhone, token, type: 'sms',
      });
      if (error) throw error;
      onAuthed();
    } catch (e) {
      showError(friendlyError(e, 'Verification failed. Check the code and try again.'));
    } finally {
      $('btn-verify-otp').disabled = false;
    }
  });

  $('btn-resend-otp').addEventListener('click', async () => {
    if (!pendingPhone) return;
    try {
      const { error } = await supabase.auth.signInWithOtp({ phone: pendingPhone });
      if (error) throw error;
      toast('Code resent');
    } catch (e) { showError(friendlyError(e)); }
  });

  $('btn-back-phone').addEventListener('click', () => {
    $('auth-step-otp').hidden = true;
    $('auth-step-phone').hidden = false;
  });
}

/** Load the current user's profile row (created by backend trigger on signup). */
export async function loadProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, profile: null };
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
          toast('Referral applied — Rs 100 bonus for both! 🎉');
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
