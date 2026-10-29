/* ============================================================
   FREE GAMES — Mines / Memory Match / Flappy Jump.
   - No money in: completely free to play, attempts unlimited.
   - LEVEL system (server-side, migration 025): win a level ->
     reward (Rs 20 at L1, +Rs 5/level, cap Rs 50) credited as a
     'bonus' transaction (auto-locked by the 024 bonus wallet),
     and the next, tougher level opens. claim_free_game_win()
     pays only the stored level, so levels can't be farmed.
   - LOSE -> waiting screen (future ad slot): 15s after the 1st
     loss of the day, +15s per further loss (per game, resets
     daily). The countdown PAUSES when the player leaves and
     RESUMES when they open the same game again; state is kept
     in localStorage so it survives app restarts. The close (X)
     button appears only when the clock reaches 0.
   ============================================================ */
import { supabase, unwrapRow } from './supabase-client.js';
import { $, toast, fmtRs, unlockAudio, sounds } from './util.js';

const GAME_LABEL = { mines: 'Mines', memory: 'Memory Match', flappy: 'Flappy Jump' };
const rewardFor = (lvl) => Math.min(15 + 5 * lvl, 50);

let userId = null;
let showViewFn = null;
let bound = false;
let levels = { mines: 1, memory: 1, flappy: 1 };
let currentGame = null;

export function setUser(id) { userId = id; }

/* ---------------- progress (server) ---------------- */
async function loadProgress() {
  try {
    const { data } = await supabase.rpc('my_free_game_progress');
    const row = unwrapRow(data);
    if (row) {
      levels = {
        mines: Number(row.mines) || 1,
        memory: Number(row.memory) || 1,
        flappy: Number(row.flappy) || 1,
      };
    }
  } catch (e) { console.warn('free game progress failed', e); }
  renderHubLevels();
}

function renderHubLevels() {
  ['mines', 'memory', 'flappy'].forEach(g => {
    const lv = $('fg-lvl-' + g);
    const rw = $('fg-rew-' + g);
    if (lv) lv.textContent = levels[g];
    if (rw) rw.textContent = fmtRs(rewardFor(levels[g]));
  });
}

export function refreshFreeHub() { loadProgress(); }

async function refreshTopbar() {
  try {
    const { data } = await supabase.from('wallets').select('balance').eq('user_id', userId).maybeSingle();
    const bal = Number(unwrapRow(data)?.balance ?? NaN);
    const el = $('topbar-balance');
    if (el && !Number.isNaN(bal) && !el.textContent.includes('•')) {
      el.textContent = 'Rs ' + fmtRs(bal);
    }
    const wb = $('wallet-balance');
    if (wb && !Number.isNaN(bal)) wb.textContent = fmtRs(bal);
  } catch (e) { /* best effort */ }
}

/* ---------------- waiting screen (ad slot) ---------------- */
function pktDay() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }); }
  catch (_) { return new Date().toISOString().slice(0, 10); }
}
function waitKey(game) { return 'fgwait_' + (userId || 'anon') + '_' + game; }
function loadWait(game) {
  const fresh = { day: pktDay(), losses: 0, remain: 0 };
  try {
    const s = JSON.parse(localStorage.getItem(waitKey(game)));
    if (!s || s.day !== pktDay()) return fresh;
    return { day: s.day, losses: Number(s.losses) || 0, remain: Number(s.remain) || 0 };
  } catch (_) { return fresh; }
}
function saveWait(game, s) {
  try { localStorage.setItem(waitKey(game), JSON.stringify(s)); } catch (_) {}
}

let waitGame = null;
let waitTimer = null;

function renderWaitTime() {
  if (!waitGame) return;
  $('fg-wait-time').textContent = loadWait(waitGame).remain;
}
function stopWaitTick() { if (waitTimer) { clearInterval(waitTimer); waitTimer = null; } }
function startWaitTick() {
  stopWaitTick();
  waitTimer = setInterval(() => {
    if (!waitGame) return;
    const s = loadWait(waitGame);
    s.remain = Math.max(0, s.remain - 1);
    saveWait(waitGame, s);
    renderWaitTime();
    if (s.remain <= 0) finishWait();
  }, 1000);
}
function openWait(game) {
  const s = loadWait(game);
  if (s.remain <= 0) return;
  waitGame = game;
  $('fg-wait-label').textContent = GAME_LABEL[game] + ' — haar ke baad ka waiting time. Clock khatam ho to dobara khel sakte ho.';
  $('fg-wait-close').hidden = true;
  $('fg-wait').hidden = false;
  renderWaitTime();
  startWaitTick();
}
function finishWait() {
  stopWaitTick();
  $('fg-wait-time').textContent = '0';
  $('fg-wait-close').hidden = false;
  try { sounds.alarm(); } catch (_) {}
}
function pauseWait() { stopWaitTick(); $('fg-wait').hidden = true; }

/* A loss: escalate today's wait for this game and show the clock. */
function startWaitAfterLoss(game) {
  const s = loadWait(game);
  s.losses += 1;
  s.remain = 15 * s.losses;
  saveWait(game, s);
  openWait(game);
}

/* ---------------- win claim ---------------- */
let claiming = false;
let lastWonGame = null;
async function onWin(game) {
  stopActivity(game);
  if (claiming) return;
  claiming = true;
  try {
    const { data, error } = await supabase.rpc('claim_free_game_win', { p_game: game });
    if (error) throw error;
    const row = unwrapRow(data);
    if (!row || row.ok === false) throw new Error((row && row.error) || 'claim failed');
    levels[game] = Number(row.next_level) || levels[game] + 1;
    lastWonGame = game;
    try { sounds.win(); } catch (_) {}
    $('fg-win-reward').textContent = '+ Rs ' + fmtRs(row.reward) + ' 🔒 bonus';
    $('fg-win-next').textContent = GAME_LABEL[game] + ' · Next: Level ' + row.next_level +
      ' · Reward Rs ' + fmtRs(rewardFor(Number(row.next_level)));
    $('fg-win').hidden = false;
    renderHubLevels();
    refreshTopbar();
  } catch (e) {
    console.warn('free game claim failed', e);
    toast('Reward claim nahi ho saka — internet check karke dobara try karo.', true);
  } finally { claiming = false; }
}

/* ---------------- navigation ---------------- */
function openGame(game) {
  unlockAudio();
  currentGame = game;
  resetGameIdle(game);
  if (showViewFn) showViewFn(game);
  // A paused wait for this game resumes before the game can be played.
  if (loadWait(game).remain > 0) openWait(game);
}
function onBackFromGame() {
  if (currentGame) stopActivity(currentGame);
  if (!$('fg-wait').hidden) pauseWait();
  $('fg-win').hidden = true;
  currentGame = null;
  if (showViewFn) showViewFn('freehub');
  loadProgress();
}
function stopActivity(game) {
  if (game === 'mines') mines.playing = false;
  if (game === 'memory') { mem.playing = false; memStopTimer(); }
  if (game === 'flappy') { fl.playing = false; flStop(); }
}
function resetGameIdle(game) {
  if (game === 'mines') minesIdle();
  if (game === 'memory') memoryIdle();
  if (game === 'flappy') flappyIdle();
}

/* ============================================================
   MINES — 5x5 board. Level scaling:
   bombs = min(4 + level, 8); safe target = min(8 + 2*level, 25 - bombs)
   L1: 5 bombs / 10 safe · L2: 6/12 · L3: 7/14 · L4+: 8/16-17
   ============================================================ */
const mines = { playing: false, bombs: new Set(), opened: 0, cfg: { bombs: 5, safe: 10 } };
function minesCfg(l) {
  const bombs = Math.min(4 + l, 8);
  return { bombs, safe: Math.min(8 + 2 * l, 25 - bombs) };
}
function minesInfo() {
  const c = minesCfg(levels.mines);
  $('mines-info').textContent = 'Level ' + levels.mines + ' · Reward Rs ' + fmtRs(rewardFor(levels.mines));
  $('mines-target').innerHTML = 'Safe: ' + mines.opened + ' / ' + c.safe + ' · 💣 × ' + c.bombs;
}
function minesIdle() {
  mines.playing = false; mines.opened = 0; mines.cfg = minesCfg(levels.mines);
  const grid = $('mines-grid');
  grid.innerHTML = '';
  for (let i = 0; i < 25; i++) {
    const d = document.createElement('button');
    d.className = 'mine-tile'; d.textContent = '?'; d.disabled = true;
    grid.appendChild(d);
  }
  $('mines-msg').textContent = 'Play dabao aur safe khane kholo!';
  const btn = $('mines-play'); btn.disabled = false; btn.textContent = '▶ Play';
  minesInfo();
}
function minesStart() {
  unlockAudio();
  const c = minesCfg(levels.mines);
  mines.cfg = c; mines.opened = 0; mines.playing = true;
  mines.bombs = new Set();
  while (mines.bombs.size < c.bombs) mines.bombs.add(Math.floor(Math.random() * 25));
  const grid = $('mines-grid');
  grid.innerHTML = '';
  for (let i = 0; i < 25; i++) {
    const d = document.createElement('button');
    d.className = 'mine-tile'; d.textContent = '?';
    d.addEventListener('click', () => minesTap(i, d));
    grid.appendChild(d);
  }
  $('mines-msg').textContent = 'Safe khane kholo — bomb se bacho!';
  const btn = $('mines-play'); btn.disabled = true; btn.textContent = 'Playing…';
  minesInfo();
}
function minesTap(i, el) {
  if (!mines.playing || el.classList.contains('open')) return;
  if (mines.bombs.has(i)) {
    el.classList.add('bomb'); el.textContent = '💣';
    mines.playing = false;
    try { sounds.lose(); } catch (_) {}
    $('mines-msg').textContent = '💣 Bomb phat gaya! Level fail.';
    const btn = $('mines-play'); btn.disabled = false; btn.textContent = '▶ Play again';
    startWaitAfterLoss('mines');
    return;
  }
  el.classList.add('open'); el.textContent = '💎';
  try { sounds.click(); } catch (_) {}
  mines.opened++;
  minesInfo();
  if (mines.opened >= mines.cfg.safe) {
    mines.playing = false;
    $('mines-msg').textContent = '🎉 Target pura!';
    onWin('mines');
  }
}

/* ============================================================
   MEMORY MATCH — pairs ladder with box-based seconds:
   pairs = min(6 + 2*(L-1), 16); seconds = 20 + (pairs-6) * 3.5
   L1: 6 pairs / 20s · L2: 8/27s · L3: 10/34s · L4: 12/41s ·
   L5: 14/48s · L6+: 16/55s + mismatch costs -2s (extra toughness)
   ============================================================ */
const MEM_SYMBOLS = ['🍎', '🍇', '🍓', '🍌', '🍉', '🥝', '🍒', '🍍', '🥭', '🍑', '🍋', '🍊', '🦁', '🐯', '🦊', '🐼', '🚗', '✈️'];
const mem = { playing: false, lock: false, first: null, found: 0, timer: null, endAt: 0, cfg: { pairs: 6, seconds: 20, penalty: 0 } };
function memCfg(l) {
  const pairs = Math.min(6 + 2 * (l - 1), 16);
  return { pairs, seconds: 20 + (pairs - 6) * 7 / 2, penalty: l >= 6 ? 2 : 0 };
}
function memInfo() {
  $('memory-info').textContent = 'Level ' + levels.memory + ' · Reward Rs ' + fmtRs(rewardFor(levels.memory));
  $('memory-pairs').textContent = mem.found + ' / ' + mem.cfg.pairs;
}
function memStopTimer() { if (mem.timer) { clearInterval(mem.timer); mem.timer = null; } }
function memRenderTime() {
  const left = Math.max(0, Math.ceil((mem.endAt - Date.now()) / 1000));
  const el = $('memory-timer');
  el.textContent = '⏱ ' + left;
  el.classList.toggle('danger', left <= 5 && mem.playing);
  return left;
}
function memoryIdle() {
  mem.playing = false; mem.found = 0; mem.first = null; mem.lock = false;
  memStopTimer();
  mem.cfg = memCfg(levels.memory);
  const grid = $('memory-grid');
  grid.style.gridTemplateColumns = 'repeat(4, 1fr)';
  grid.innerHTML = '';
  for (let i = 0; i < mem.cfg.pairs * 2; i++) {
    const d = document.createElement('div');
    d.className = 'mem-card'; d.textContent = '❓';
    grid.appendChild(d);
  }
  $('memory-timer').textContent = '⏱ ' + mem.cfg.seconds;
  $('memory-msg').textContent = 'Play dabao aur joriyan milao!';
  const btn = $('memory-play'); btn.disabled = false; btn.textContent = '▶ Play';
  memInfo();
}
/* True-random shuffle (Fisher-Yates) — no positional bias, so no
   pattern or trick can ever be learned; every attempt is unique. */
function shuffleFY(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function memoryStart() {
  unlockAudio();
  const c = memCfg(levels.memory);
  mem.cfg = c; mem.found = 0; mem.first = null; mem.lock = false; mem.playing = true;
  // Random symbol subset each attempt + fully shuffled deck.
  const syms = shuffleFY([...MEM_SYMBOLS]).slice(0, c.pairs);
  const deck = shuffleFY([...syms, ...syms]);
  const grid = $('memory-grid');
  grid.style.gridTemplateColumns = 'repeat(4, 1fr)';
  grid.innerHTML = '';
  deck.forEach(sym => {
    const d = document.createElement('div');
    d.className = 'mem-card'; d.textContent = '❓'; d.dataset.sym = sym;
    d.addEventListener('click', () => memFlip(d));
    grid.appendChild(d);
  });
  $('memory-msg').textContent = c.penalty ? 'Joriyan milao — galat card par −' + c.penalty + ' sec!' : 'Joriyan milao!';
  const btn = $('memory-play'); btn.disabled = true; btn.textContent = 'Playing…';
  mem.endAt = Date.now() + c.seconds * 1000;
  memStopTimer();
  mem.timer = setInterval(() => { if (memRenderTime() <= 0) memoryLose(); }, 200);
  memRenderTime();
  memInfo();
}
function memFlip(card) {
  if (!mem.playing || mem.lock || card.classList.contains('face') || card.classList.contains('done')) return;
  try { sounds.click(); } catch (_) {}
  card.classList.add('face'); card.textContent = card.dataset.sym;
  if (!mem.first) { mem.first = card; return; }
  if (mem.first.dataset.sym === card.dataset.sym) {
    mem.first.classList.add('done'); card.classList.add('done');
    mem.first = null; mem.found++;
    memInfo();
    if (mem.found >= mem.cfg.pairs) {
      mem.playing = false; memStopTimer();
      $('memory-msg').textContent = '🎉 Board pura!';
      onWin('memory');
    }
    return;
  }
  mem.lock = true;
  const a = mem.first; mem.first = null;
  setTimeout(() => {
    a.classList.remove('face'); a.textContent = '❓';
    card.classList.remove('face'); card.textContent = '❓';
    if (mem.cfg.penalty && mem.playing) { mem.endAt -= mem.cfg.penalty * 1000; memRenderTime(); }
    mem.lock = false;
  }, 620);
}
function memoryLose() {
  if (!mem.playing) return;
  mem.playing = false; memStopTimer();
  try { sounds.lose(); } catch (_) {}
  $('memory-msg').textContent = '⏱ Time khatam! Level fail.';
  const btn = $('memory-play'); btn.disabled = false; btn.textContent = '▶ Play again';
  startWaitAfterLoss('memory');
}

/* ============================================================
   FLAPPY JUMP — canvas. Level scaling:
   target pipes = min(5 + 5*L, 50); speed grows, gap tightens.
   ============================================================ */
const fl = { playing: false, raf: 0, y: 220, vy: 0, pipes: [], score: 0, cfg: { target: 10, speed: 2, gap: 124 } };
const FL_W = 360, FL_H = 460, FL_X = 66;
function flCfg(l) {
  return {
    target: Math.min(5 + 5 * l, 50),
    speed: Math.min(2 + 0.12 * (l - 1), 3.4),
    gap: Math.max(108, 126 - 2 * (l - 1)),
  };
}
function flInfo() {
  $('flappy-info').textContent = 'Level ' + levels.flappy + ' · Reward Rs ' + fmtRs(rewardFor(levels.flappy));
  $('flappy-score').textContent = fl.score + ' / ' + fl.cfg.target;
}
function flStop() { if (fl.raf) cancelAnimationFrame(fl.raf); fl.raf = 0; }
function flDraw() {
  const cv = $('flappy-canvas'); if (!cv) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, FL_W, FL_H);
  // pipes
  fl.pipes.forEach(p => {
    ctx.fillStyle = '#1f9d4d';
    ctx.strokeStyle = '#0d5c2a'; ctx.lineWidth = 2;
    ctx.fillRect(p.x, 0, 64, p.top); ctx.strokeRect(p.x, -2, 64, p.top + 2);
    ctx.fillRect(p.x, p.top + fl.cfg.gap, 64, FL_H - p.top - fl.cfg.gap);
    ctx.strokeRect(p.x, p.top + fl.cfg.gap, 64, FL_H - p.top - fl.cfg.gap + 2);
    ctx.fillStyle = '#2ee06f';
    ctx.fillRect(p.x - 3, p.top - 18, 70, 18);
    ctx.fillRect(p.x - 3, p.top + fl.cfg.gap, 70, 18);
  });
  // bird
  ctx.font = '30px serif';
  ctx.textAlign = 'center';
  ctx.fillText('🐤', FL_X, fl.y + 10);
}
function flappyIdle() {
  fl.playing = false; fl.score = 0; fl.y = 220; fl.vy = 0; fl.pipes = [];
  flStop();
  fl.cfg = flCfg(levels.flappy);
  flDraw();
  $('flappy-msg').textContent = 'Play dabao, phir screen tap karke urao!';
  const btn = $('flappy-play'); btn.disabled = false; btn.textContent = '▶ Play';
  flInfo();
}
function flappyStart() {
  unlockAudio();
  fl.cfg = flCfg(levels.flappy);
  fl.score = 0; fl.y = 220; fl.vy = 0; fl.pipes = []; fl.playing = true;
  $('flappy-msg').textContent = 'Tap! Tap! Pipes se bacho!';
  const btn = $('flappy-play'); btn.disabled = true; btn.textContent = 'Playing…';
  flInfo();
  flStop();
  const step = () => {
    if (!fl.playing) return;
    fl.vy += 0.45; fl.y += fl.vy;
    const last = fl.pipes[fl.pipes.length - 1];
    if (!last || last.x < FL_W - 175) {
      const top = 55 + Math.random() * (FL_H - fl.cfg.gap - 130);
      fl.pipes.push({ x: FL_W + 12, top, passed: false });
    }
    fl.pipes.forEach(p => { p.x -= fl.cfg.speed; });
    fl.pipes = fl.pipes.filter(p => p.x > -75);
    // scoring
    for (const p of fl.pipes) {
      if (!p.passed && p.x + 64 < FL_X) {
        p.passed = true; fl.score++; flInfo();
        if (fl.score >= fl.cfg.target) { flappyWin(); return; }
      }
      if (FL_X + 13 > p.x && FL_X - 13 < p.x + 64 &&
          (fl.y - 12 < p.top || fl.y + 12 > p.top + fl.cfg.gap)) { flappyLose(); return; }
    }
    if (fl.y > FL_H - 12) { flappyLose(); return; }
    if (fl.y < 14) { fl.y = 14; fl.vy = 0; }
    flDraw();
    fl.raf = requestAnimationFrame(step);
  };
  fl.raf = requestAnimationFrame(step);
}
function flappyWin() {
  fl.playing = false; flStop(); flDraw();
  $('flappy-msg').textContent = '🎉 Target pura!';
  onWin('flappy');
}
function flappyLose() {
  if (!fl.playing) return;
  fl.playing = false; flStop(); flDraw();
  try { sounds.lose(); } catch (_) {}
  $('flappy-msg').textContent = '💥 Takra gaye! Level fail.';
  const btn = $('flappy-play'); btn.disabled = false; btn.textContent = '▶ Play again';
  startWaitAfterLoss('flappy');
}

/* ---------------- init ---------------- */
export function initFreeGames(showView) {
  if (bound) { if (showView) showViewFn = showView; return; }
  bound = true;
  showViewFn = showView;

  ['mines', 'memory', 'flappy'].forEach(g => {
    const pick = $('fg-pick-' + g);
    if (pick) pick.addEventListener('click', () => openGame(g));
  });
  document.querySelectorAll('.fg-back').forEach(b =>
    b.addEventListener('click', () => { try { sounds.click(); } catch (_) {} onBackFromGame(); }));

  $('mines-play').addEventListener('click', minesStart);
  $('memory-play').addEventListener('click', memoryStart);
  $('flappy-play').addEventListener('click', flappyStart);
  $('flappy-canvas').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (fl.playing) { fl.vy = -7.6; try { sounds.click(); } catch (_) {} }
  });

  $('fg-wait-pause').addEventListener('click', () => { pauseWait(); onBackFromGame(); });
  $('fg-wait-close').addEventListener('click', () => {
    $('fg-wait').hidden = true;
    try { sounds.click(); } catch (_) {}
  });
  $('fg-win-next-btn').addEventListener('click', () => {
    $('fg-win').hidden = true;
    if (lastWonGame) openGame(lastWonGame);
  });
  $('fg-win-hub-btn').addEventListener('click', () => {
    $('fg-win').hidden = true;
    onBackFromGame();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Pause the wait clock (and any running game timers keep server-free state).
      if (!$('fg-wait').hidden) stopWaitTick();
      if (mem.playing) { /* memory uses wall-clock endAt; time keeps counting fairly */ }
    } else {
      if (!$('fg-wait').hidden && waitGame && loadWait(waitGame).remain > 0) startWaitTick();
    }
  });

  loadProgress();
}
