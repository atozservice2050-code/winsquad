/* ============================================================
   Disclaimer — shown once on first login.
   "I Agree" saves winsquad_disclaimer_accepted=true in localStorage.
   ============================================================ */
import { $ } from './util.js';

const KEY = 'winsquad_disclaimer_accepted';

export function maybeShowDisclaimer() {
  try {
    if (localStorage.getItem(KEY) === 'true') return;
  } catch (e) { /* storage unavailable: show it anyway */ }
  const modal = $('disclaimer-modal');
  if (!modal) return;
  modal.hidden = false;
  modal.style.display = 'flex';
}

export function initDisclaimer() {
  const btn = $('btn-disclaimer-agree');
  if (!btn) return;
  btn.addEventListener('click', () => {
    try { localStorage.setItem(KEY, 'true'); } catch (e) {}
    const modal = $('disclaimer-modal');
    if (modal) { modal.hidden = true; modal.style.display = ''; }
  });
}
