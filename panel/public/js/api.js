// Thin API client + shared UI helpers (toast, escaping). Exposed on window so
// app.js (also a module) can use them without a bundler.
const TOKEN_KEY = 'logwatch_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && getToken()) headers.authorization = `Bearer ${getToken()}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && auth) {
    clearToken();
    location.hash = '#/login';
    throw new Error('session expired');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function fmtTime(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString();
}
export function fmtAgo(unix) {
  if (!unix) return 'never';
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Make helpers available globally for app.js inline handlers.
window.LW = { api, getToken, setToken, clearToken, toast, esc, fmtTime, fmtAgo };
