/* ============================================================
   MISSIONS — b9-style mission cards with claimable rewards.
   - Progress tracked in localStorage per user (simple).
   - Claim goes through the `claim_mission` SECURITY DEFINER RPC
     which credits the wallet server-side (prevents double-claim).
   - Other modules report events via recordMissionEvent(type, data).
   ============================================================ */
import { supabase } from './supabase-client.js';
import { $, toast, fmtRs, unlockAudio, sounds } from './util.js';
import { refreshWallet } from './wallet.js';

let userId = null;
export function setUser(id) { userId = id; }

/* Mission definitions (rewards must match the claim_mission RPC). */
export const MISSIONS = [
  { id: 'first_bid',     title: 'First Bid',     desc: 'Place 1 bid',            target: 1, reward: 50 },
  { id: 'lucky_streak',  title: 'Lucky Streak',  desc: 'Win 3 times',            target: 3, reward: 100 },
  { id: 'daily_visitor', title: 'Daily Visitor', desc: 'Claim a daily reward',   target: 1, reward: 10 },
  { id: 'high_roller',   title: 'High Roller',   desc: 'Place a Rs 500+ bid',    target: 1, reward: 200 },
  { id: 'social_star',   title: 'Social Star',   desc: 'Refer 1 friend',         target: 1, reward: 500 },
];

function storeKey() { return 'ws_missions_' + (userId || 'guest'); }

function loadState() {
  try {
    const raw = localStorage.getItem(storeKey());
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return {};
}

function saveState(state) {
  try { localStorage.setItem(storeKey(), JSON.stringify(state)); }
  catch (e) { /* ignore */ }
}

function missionState(id) {
  const s = loadState();
  return s[id] || { progress: 0, claimed: false };
}

function setMissionState(id, patch) {
  const s = loadState();
  s[id] = { ...(s[id] || { progress: 0, claimed: false }), ...patch };
  saveState(s);
}

/* Called by other modules when game events happen. */
export function recordMissionEvent(type, data = {}) {
  if (!userId) return;
  const bump = (id, by = 1) => {
    const m = MISSIONS.find(x => x.id === id);
    if (!m) return;
    const cur = missionState(id);
    if (cur.claimed) return;
    const next = Math.min(m.target, (cur.progress || 0) + by);
    if (next !== cur.progress) {
      setMissionState(id, { progress: next });
      if (next >= m.target) toast('🎯 Mission complete: ' + m.title + '! Claim Rs ' + fmtRs(m.reward));
      if (document.querySelector('#view-missions:not([hidden])')) renderMissions();
    }
  };
  switch (type) {
    case 'bid':
      bump('first_bid');
      if (Number(data.amount || 0) >= 500) bump('high_roller');
      break;
    case 'win':
      bump('lucky_streak');
      break;
    case 'daily_visit':
      bump('daily_visitor');
      break;
    case 'referral':
      bump('social_star');
      break;
  }
}

function cardHtml(m) {
  const st = missionState(m.id);
  const done = st.progress >= m.target;
  const pct = Math.min(100, Math.round((st.progress / m.target) * 100));
  const status = st.claimed
    ? '<span class="mission-status claimed">CLAIMED ✓</span>'
    : done
      ? '<button class="mission-claim" data-claim="' + m.id + '">CLAIM Rs ' + fmtRs(m.reward) + '</button>'
      : '<span class="mission-status">IN PROGRESS</span>';
  return (
    '<div class="mission-card">' +
      '<div class="mission-title">' + m.title + '</div>' +
      '<div class="mission-desc">' + m.desc + '</div>' +
      '<div class="mission-bar"><div class="mission-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="mission-foot">' +
        '<span>' + st.progress + '/' + m.target + ' · 🪙 ' + fmtRs(m.reward) + '</span>' +
        status +
      '</div>' +
    '</div>'
  );
}

function renderMissions() {
  const list = $('missions-list');
  if (!list) return;
  list.innerHTML = MISSIONS.map(cardHtml).join('');
  list.querySelectorAll('[data-claim]').forEach(btn => {
    btn.addEventListener('click', () => claimMission(btn.dataset.claim, btn));
  });
}

async function claimMission(missionId, btn) {
  unlockAudio();
  const m = MISSIONS.find(x => x.id === missionId);
  if (!m) return;
  const st = missionState(missionId);
  if (st.claimed || st.progress < m.target) return;
  btn.disabled = true;
  btn.textContent = 'Claiming…';
  try {
    const { data, error } = await supabase.rpc('claim_mission', { p_mission_id: missionId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    const ok = row && (row.ok === true || row === true);
    if (!ok) {
      const msg = (row && row.error) || 'Claim failed';
      throw new Error(msg);
    }
    setMissionState(missionId, { claimed: true });
    sounds.win();
    toast('🎉 Rs ' + fmtRs(m.reward) + ' claimed! Added to wallet.');
    try { await refreshWallet(); } catch (e) {}
    renderMissions();
    refreshBalance();
  } catch (e) {
    console.warn('claim_mission failed', e);
    toast('Claim failed: ' + (e.message || 'try again later'), true);
    btn.disabled = false;
    btn.textContent = 'CLAIM Rs ' + fmtRs(m.reward);
  }
}

async function refreshBalance() {
  try {
    const { data } = await supabase.from('wallets').select('balance').maybeSingle();
    const bal = data && (Array.isArray(data) ? data[0] : data);
    const el = $('missions-balance');
    if (el) el.textContent = 'Rs ' + fmtRs(bal?.balance ?? 0);
  } catch (e) { /* ignore */ }
}

export function initMissions() {
  renderMissions();
}

export function refreshMissions() {
  renderMissions();
  refreshBalance();
}
