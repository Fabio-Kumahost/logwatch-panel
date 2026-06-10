// Thin API client + shared UI helpers (toast, escaping). Exposed on window so
// app.js (also a module) can use them without a bundler.
const TOKEN_KEY = 'logwatch_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

// fetch with automatic retry: the hosting network sometimes drops brand-new
// TCP connections ("Failed to fetch"); a quick retry almost always succeeds.
async function fetchRetry(path, opts, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(path, opts);
    } catch (err) {
      if (attempt >= retries) {
        throw new Error('Network error — the panel could not be reached. The connection usually recovers within seconds; please try again.');
      }
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  // Only declare a JSON content-type when we actually send a body — Fastify
  // rejects an empty body with a JSON content-type as 400 Bad Request.
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && getToken()) headers.authorization = `Bearer ${getToken()}`;
  const res = await fetchRetry(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
