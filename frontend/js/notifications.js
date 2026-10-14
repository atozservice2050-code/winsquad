/* WinSquad notifications: in-app notification center.
   Stores notifications in localStorage, shows bell badge, panel UI. */

const NOTIF_KEY = 'winsquad_notifications';
const MAX_NOTIFS = 50;

export function getNotifications() {
  try {
    const raw = localStorage.getItem(NOTIF_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveNotifications(arr) {
  try {
    localStorage.setItem(NOTIF_KEY, JSON.stringify(arr.slice(0, MAX_NOTIFS)));
  } catch {}
}

export function addNotification({ title, body, icon = '🔔', type = 'info' }) {
  const notifs = getNotifications();
  notifs.unshift({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    title, body, icon, type,
    time: Date.now(),
    read: false,
  });
  saveNotifications(notifs);
  updateNotifBadge();
  // Browser notification if permission granted and app in background
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification(title, { body, icon: '/icon.png' });
    }
  } catch {}
}

export function markAllRead() {
  const notifs = getNotifications().map(n => ({ ...n, read: true }));
  saveNotifications(notifs);
  updateNotifBadge();
}

export function getUnreadCount() {
  return getNotifications().filter(n => !n.read).length;
}

export function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const count = getUnreadCount();
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);
}

export function renderNotifPanel() {
  let panel = document.getElementById('notif-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notif-panel';
    panel.className = 'notif-panel';
    panel.hidden = true;
    document.body.appendChild(panel);
  }
  const notifs = getNotifications();
  if (!notifs.length) {
    panel.innerHTML = '<div class="notif-empty">🔕<p>No notifications yet.<br>Play a round to get updates!</p></div>';
  } else {
    panel.innerHTML = '<div class="notif-header"><strong>Notifications</strong>' +
      '<button id="notif-clear" class="btn-ghost small">Mark all read</button></div>' +
      '<div class="notif-list">' + notifs.map(n =>
        '<div class="notif-item' + (n.read ? '' : ' unread') + '">' +
        '<span class="notif-icon">' + n.icon + '</span>' +
        '<div class="notif-body"><div class="notif-title">' + escapeHtml(n.title) + '</div>' +
        (n.body ? '<div class="notif-text">' + escapeHtml(n.body) + '</div>' : '') +
        '<div class="notif-time">' + timeAgo(n.time) + '</div></div>' +
        '</div>'
      ).join('') + '</div>';
    const clearBtn = panel.querySelector('#notif-clear');
    if (clearBtn) clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      markAllRead();
      renderNotifPanel();
    });
  }
  return panel;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

export function toggleNotifPanel() {
  const panel = renderNotifPanel();
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    // Mark as read when opened
    setTimeout(() => { markAllRead(); renderNotifPanel(); }, 1500);
  }
}

export function initNotifications() {
  updateNotifBadge();
  const bell = document.getElementById('notif-bell');
  if (bell) bell.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotifPanel();
  });
  // Close panel when clicking outside
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('notif-panel');
    if (panel && !panel.hidden && !panel.contains(e.target) &&
        e.target.id !== 'notif-bell' && !e.target.closest('#notif-bell')) {
      panel.hidden = true;
    }
  });
  // Ask for browser notification permission (optional, non-blocking)
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      // Don't auto-prompt; let user enable from settings if they want
    }
  } catch {}
}
