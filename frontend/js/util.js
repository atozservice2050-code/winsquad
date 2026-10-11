/* ============================================================
   Shared helpers: toast, sounds (Web Audio, no files), formatting,
   Pakistan-local time helpers, and tiny DOM shortcuts.
   ============================================================ */

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- toast ---------- */
let toastTimer = null;
export function toast(message, isError = false, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------- Web Audio sounds (created lazily on user gesture) ---------- */
let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function tone(freq, startAt, dur, type = 'sine', vol = 0.18) {
  const ac = ctx();
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, ac.currentTime + startAt);
  gain.gain.exponentialRampToValueAtTime(vol, ac.currentTime + startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + startAt + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(ac.currentTime + startAt);
  osc.stop(ac.currentTime + startAt + dur + 0.05);
}
/** Call once inside a real click handler so mobile browsers allow audio. */
export function unlockAudio() { ctx(); }

export const sounds = {
  win()  { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.11, 0.28, 'triangle')); },
  lose() { [392, 311.13, 233.08].forEach((f, i) => tone(f, i * 0.16, 0.3, 'sawtooth', 0.1)); },
  tick() { tone(880, 0, 0.07, 'square', 0.06); },
  click(){ tone(660, 0, 0.05, 'sine', 0.08); },
  alarm(){ [740, 740, 740].forEach((f, i) => tone(f, i * 0.18, 0.14, 'square', 0.09)); },
};

/* ---------- formatting ---------- */
export function fmtRs(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return v.toLocaleString('en-PK', { maximumFractionDigits: 0 });
}
export function fmtTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return ''; }
}
/** Current hour (0-23) in Pakistan time. */
export function pktHour(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-PK', {
      timeZone: 'Asia/Karachi', hour: 'numeric', hour12: false,
    }).formatToParts(date);
    const h = Number((parts.find(p => p.type === 'hour') || {}).value);
    return h === 24 ? 0 : h;
  } catch { return date.getHours(); }
}
/** Fear-&-Greed style activity level from the real clock (PKT). */
export function activityLevel() {
  const h = pktHour();
  if (h >= 18 && h < 24) return 'peak';    // 6PM–12AM: busiest
  if (h >= 0 && h < 6)  return 'down';     // overnight: quiet
  return 'normal';                          // daytime
}
/** Normalize a Pakistani mobile number to +92 E.164. Returns null if invalid. */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  let d = digits;
  if (d.startsWith('0')) d = '92' + d.slice(1);
  if (!d.startsWith('92')) d = '92' + d;
  // Pakistani mobiles: 92 3XX XXXXXXX (12 digits total)
  if (!/^923\d{9}$/.test(d)) return null;
  return '+' + d;
}
/** Copy text to clipboard with fallback. */
export async function copyText(text, label = 'Copied!') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(label); }
    catch { toast('Copy failed — long-press to copy', true); }
    ta.remove();
  }
}
