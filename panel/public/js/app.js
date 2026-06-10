import { api, getToken, setToken, clearToken, toast, esc, fmtTime, fmtAgo, downloadWithAuth } from '/js/api.js?v=1.6.0';
import { suggestFix } from '/js/solutions.js?v=1.6.0';

const root = document.getElementById('root');
let me = null;

// Connection keep-alive ----------------------------------------------------
// The hosting network drops some brand-new TCP connections while established
// ones stay healthy. A periodic lightweight ping keeps a pooled connection
// warm so user actions reuse it instead of opening a fresh (riskier) one.
setInterval(() => {
  if (document.visibilityState === 'visible' && getToken()) {
    fetch('/api/v1/health', { cache: 'no-store' }).catch(() => {});
  }
}, 20000);

// Theme -------------------------------------------------------------------
const savedTheme = localStorage.getItem('lw_theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('lw_theme', next);
}

// Router ------------------------------------------------------------------
const routes = {
  '/login': renderLogin,
  '/dashboard': renderDashboard,
  '/logs': renderLogs,
  '/insights': renderInsights,
  '/alerts': renderAlerts,
  '/settings': renderSettings,
};

async function router() {
  const hash = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, param] = hash.split('/').filter(Boolean).reduce((acc, p, i) => {
    if (i === 0) acc[0] = '/' + p; else acc[1] = p;
    return acc;
  }, ['/dashboard', null]);

  if (!getToken()) return renderLogin();
  if (!me) {
    try { me = (await api('/api/v1/auth/me')).user; }
    catch { return renderLogin(); }
    try { window._ai = await api('/api/v1/ai/status'); } catch { window._ai = { enabled: false }; }
  }
  if (path === '/servers' && param) return renderServerDetail(param);
  const view = routes[path] || renderDashboard;
  if (view === renderLogin) { location.hash = '#/dashboard'; return; }
  view();
}
window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', router);
router();

// Shell -------------------------------------------------------------------
function shell(active, contentHtml) {
  const nav = [
    ['/dashboard', '📊 Dashboard'],
    ['/logs', '📜 Logs'],
    ['/insights', '🧠 Insights'],
    ['/alerts', '🔔 Alerts'],
    ['/settings', '⚙️ Settings'],
  ].map(([h, label]) => `<a href="#${h}" class="${active === h ? 'active' : ''}">${label}</a>`).join('');
  root.innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="brand">📡 LogWatch</div>
        <nav class="nav">${nav}</nav>
        <div class="bottom">
          <button class="btn secondary sm" id="themeBtn">🌓 Theme</button>
          <button class="btn secondary sm" id="logoutBtn">⎋ Logout (${esc(me?.username || '')})</button>
        </div>
      </aside>
      <main class="main">${contentHtml}</main>
    </div>`;
  document.getElementById('themeBtn').onclick = toggleTheme;
  document.getElementById('logoutBtn').onclick = () => { clearToken(); me = null; location.hash = '#/login'; };
}

// Login -------------------------------------------------------------------
function renderLogin() {
  root.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="logo">📡</div>
        <h1>LogWatch Panel</h1>
        <div class="dim">Sign in to your fleet log console</div>
        <form id="loginForm">
          <input name="username" placeholder="Username" autocomplete="username" autofocus required />
          <input name="password" type="password" placeholder="Password" autocomplete="current-password" required />
          <input name="totp" id="totpField" class="hidden" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit 2FA code" maxlength="6" />
          <div class="error-msg" id="loginErr"></div>
          <button class="btn" type="submit">Sign in</button>
        </form>
      </div>
    </div>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { username: f.get('username'), password: f.get('password') };
    const totp = (f.get('totp') || '').trim();
    if (totp) body.totp = totp;
    try {
      const res = await api('/api/v1/auth/login', { method: 'POST', auth: false, body });
      setToken(res.token); me = res.user;
      location.hash = '#/dashboard';
    } catch (err) {
      if (err.message === 'totp_required') {
        document.getElementById('totpField').classList.remove('hidden');
        document.getElementById('totpField').focus();
        document.getElementById('loginErr').textContent = 'Enter your 2FA code to continue.';
        return;
      }
      document.getElementById('loginErr').textContent = err.message;
    }
  };
}

// Dashboard ---------------------------------------------------------------
async function renderDashboard() {
  shell('/dashboard', `<div id="updateBanner"></div><div class="page-head"><h2>Dashboard</h2></div><div id="dash">Loading…</div>`);
  renderUpdateBanner();
  try {
    const [servers, stats, agentVer, ts] = await Promise.all([
      api('/api/v1/servers'),
      api('/api/v1/logs/stats'),
      api('/api/v1/agent/version').catch(() => null),
      api('/api/v1/logs/timeseries').catch(() => ({ series: [] })),
    ]);
    window._agentLatest = agentVer?.version || null;
    const online = servers.filter((s) => s.status === 'online').length;
    const byLevel = Object.fromEntries((stats.last24h || []).map((r) => [r.level, r.n]));
    const dash = document.getElementById('dash');
    dash.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="n">${servers.length}</div><div class="l">Servers</div></div>
        <div class="stat"><div class="n" style="color:var(--green)">${online}</div><div class="l">Online</div></div>
        <div class="stat"><div class="n" style="color:var(--red)">${servers.length - online}</div><div class="l">Offline / pending</div></div>
        <div class="stat"><div class="n">${stats.total.toLocaleString()}</div><div class="l">Total logs</div></div>
        <div class="stat"><div class="n" style="color:var(--orange)">${byLevel.error || 0}</div><div class="l">Errors (24h)</div></div>
        <div class="stat"><div class="n" style="color:var(--red)">${byLevel.critical || 0}</div><div class="l">Critical (24h)</div></div>
      </div>
      <div class="cards" style="grid-template-columns:2fr 1fr">
        <div class="card"><div class="l dim" style="margin-bottom:8px">LOG VOLUME · LAST 24H</div>${volumeChart(ts.series || [])}</div>
        <div class="card"><div class="l dim" style="margin-bottom:8px">BY LEVEL · 24H</div>${levelChart(byLevel)}</div>
      </div>
      <div class="page-head" style="margin-top:22px"><h2>Servers</h2><div class="spacer"></div><button class="btn" id="addServer">+ Add server</button></div>
      <div class="cards">${servers.map(serverCard).join('') || '<div class="dim">No servers yet. Click “Add server”.</div>'}</div>`;
    document.getElementById('addServer').onclick = addServerModal;
  } catch (err) { toast(err.message, 'error'); }
}

// --- Tiny dependency-free SVG charts ---
function volumeChart(series) {
  if (!series.length) return '<div class="dim">No data yet.</div>';
  const W = 560, H = 120, pad = 4;
  const max = Math.max(1, ...series.map((s) => s.total));
  const bw = (W - pad * 2) / series.length;
  const bars = series.map((s, i) => {
    const x = pad + i * bw;
    const th = ((s.total / max) * (H - 20));
    const eh = ((s.errors / max) * (H - 20));
    const t = new Date(s.hour * 1000).getHours();
    return `<g>
      <rect x="${x + 1}" y="${H - 16 - th}" width="${bw - 2}" height="${th}" fill="var(--accent)" opacity="0.55" rx="2">
        <title>${t}:00 — ${s.total} logs, ${s.errors} errors</title></rect>
      <rect x="${x + 1}" y="${H - 16 - eh}" width="${bw - 2}" height="${eh}" fill="var(--red)" rx="2"></rect>
    </g>`;
  }).join('');
  const labels = series.map((s, i) => (i % 4 === 0 ? `<text x="${pad + i * bw + 2}" y="${H - 3}" font-size="9" fill="var(--text-dim)">${new Date(s.hour * 1000).getHours()}h</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block">${bars}${labels}</svg>
    <div class="dim" style="font-size:11px;margin-top:4px"><span style="color:var(--accent)">▮</span> total · <span style="color:var(--red)">▮</span> errors</div>`;
}

function levelChart(byLevel) {
  const order = ['critical', 'error', 'warning', 'notice', 'info', 'debug'];
  const total = order.reduce((a, l) => a + (byLevel[l] || 0), 0) || 1;
  return order.map((l) => {
    const n = byLevel[l] || 0;
    const pct = Math.round((n / total) * 100);
    return `<div style="margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;font-size:12px"><span class="badge lvl-${l}">${l}</span><span class="dim">${n}</span></div>
      <div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden;margin-top:3px">
        <div style="height:100%;width:${pct}%;background:var(--accent)"></div></div>
    </div>`;
  }).join('');
}

async function renderUpdateBanner() {
  try {
    const u = await api('/api/v1/system/update');
    if (!u.update_available) return;
    const el = document.getElementById('updateBanner');
    if (!el) return;
    el.innerHTML = `<div class="card" style="margin-bottom:16px;border-color:var(--accent)">
      🚀 <b>Update available:</b> v${esc(u.current)} → <b>v${esc(u.latest)}</b>
      <div class="row" style="margin-top:10px">
        <button class="btn" id="applyUpdBanner">⬆ Update now</button>
        <button class="btn secondary sm" id="copyUpd">Copy manual command</button>
      </div>
      <div id="updProgress" class="dim" style="margin-top:8px"></div>
    </div>`;
    document.getElementById('applyUpdBanner').onclick = () => applyUpdate(u.current, 'applyUpdBanner');
    document.getElementById('copyUpd').onclick = () => { navigator.clipboard.writeText(u.update_command); toast('Copied', 'success'); };
  } catch { /* update info is best-effort */ }
}

// One-click update: trigger server-side updater, then poll until the panel
// comes back with a new version and reload the UI.
async function applyUpdate(currentVersion, btnId) {
  const btn = document.getElementById(btnId);
  const progress = document.getElementById('updProgress');
  const say = (msg) => { if (progress) progress.textContent = msg; };
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  try {
    await api('/api/v1/system/update/apply', { method: 'POST', body: {} });
  } catch (err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '⬆ Update now'; }
    return;
  }
  say('Update started — the panel will restart, this takes ~1 minute…');
  const t0 = Date.now();
  while (Date.now() - t0 < 4 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch('/api/v1/health', { cache: 'no-store' });
      if (!res.ok) continue;
      const h = await res.json();
      if (h.version && h.version !== currentVersion) {
        say(`Updated to v${h.version} — reloading…`);
        toast(`Updated to v${h.version}`, 'success');
        setTimeout(() => location.reload(), 1200);
        return;
      }
      say(`Panel is up (still v${h.version}) — waiting for the new version…`);
    } catch {
      say('Panel is restarting…'); // expected while the service restarts
    }
  }
  say('');
  toast('Update did not finish in time — check: journalctl -u logwatch-panel-updater', 'error');
  if (btn) { btn.disabled = false; btn.textContent = '⬆ Update now'; }
}

function serverCard(s) {
  return `<div class="card server-card">
    <div class="top">
      <div><h3>${esc(s.name)}</h3><div class="dim">${esc(s.hostname || '—')} · ${esc(s.group_name)}</div></div>
      <span class="dot ${s.status}" title="${s.status}"></span>
    </div>
    <div class="server-meta">
      <div>OS: ${esc(s.os || '—')} ${esc(s.os_version || '')}</div>
      <div>Agent: ${esc(s.agent_version || '—')}${
        window._agentLatest && s.agent_version && s.agent_version !== window._agentLatest
          ? ` <span title="Update to ${esc(window._agentLatest)} available — agent self-updates within 1h">⬆️</span>`
          : ''
      }</div>
      <div>Last log: ${fmtAgo(s.last_log)}</div>
      <div>Last seen: ${fmtAgo(s.last_seen)}</div>
    </div>
    <div class="row" style="margin-top:12px">
      <a class="btn secondary sm" href="#/servers/${s.id}">Details</a>
      <a class="btn secondary sm" href="#/logs?server_id=${s.id}">Logs</a>
    </div>
  </div>`;
}

async function addServerModal() {
  modal(`<h3>Add server</h3>
    <div class="form-grid">
      <label>Name<input id="srvName" placeholder="web-01" /></label>
      <label>Group<input id="srvGroup" placeholder="default" value="default" /></label>
      <label>Source IP <span class="dim">(optional — for syslog/foreign-source ingest mapping)</span><input id="srvIp" placeholder="e.g. 10.0.0.5" /></label>
      <div class="row"><button class="btn" id="srvCreate">Create</button><button class="btn secondary" onclick="LW.closeModal()">Cancel</button></div>
      <div id="srvResult"></div>
    </div>`);
  document.getElementById('srvCreate').onclick = async () => {
    const name = document.getElementById('srvName').value.trim();
    if (!name) return;
    try {
      const ip = document.getElementById('srvIp').value.trim();
      const r = await api('/api/v1/servers', { method: 'POST', body: { name, group_name: document.getElementById('srvGroup').value.trim() || 'default', ...(ip ? { ingest_ip: ip } : {}) } });
      document.getElementById('srvResult').innerHTML = `
        <div class="dim" style="margin-top:8px">Run this on the new server (token shown once):</div>
        <div class="code-box">${esc(r.install_command)}</div>
        <button class="btn sm" id="copyCmd">Copy</button>`;
      document.getElementById('copyCmd').onclick = () => { navigator.clipboard.writeText(r.install_command); toast('Copied', 'success'); };
    } catch (err) { toast(err.message, 'error'); }
  };
}

// Server detail -----------------------------------------------------------
async function renderServerDetail(id) {
  shell('/dashboard', `<div class="page-head"><a href="#/dashboard" class="btn secondary sm">← Back</a><h2 id="sdTitle">Server</h2></div><div id="sd">Loading…</div>`);
  try {
    const s = await api(`/api/v1/servers/${id}`);
    document.getElementById('sdTitle').textContent = s.name;
    const latest = (s.metrics && s.metrics.length) ? s.metrics[s.metrics.length - 1] : null;
    const gauge = (label, val, unit = '%') => {
      if (val == null) return '';
      const color = val >= 90 ? 'var(--red)' : val >= 75 ? 'var(--orange)' : 'var(--green)';
      return `<div class="stat"><div class="n" style="color:${color}">${val}${unit}</div><div class="l">${label}</div></div>`;
    };
    const metricsHtml = latest ? `
      <div class="page-head" style="margin-top:4px"><h3 style="margin:0">Host metrics</h3><span class="dim" style="margin-left:8px">updated ${fmtAgo(latest.ts)}</span></div>
      <div class="stat-grid">
        ${gauge('CPU', latest.cpu)}${gauge('Memory', latest.mem)}${gauge('Disk', latest.disk)}
        <div class="stat"><div class="n">${latest.load1 ?? '—'}</div><div class="l">Load (1m)</div></div>
      </div>
      <div class="card" style="margin-bottom:16px">${metricSpark(s.metrics)}</div>` : '';
    document.getElementById('sd').innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="n">${s.stats?.total || 0}</div><div class="l">Total logs</div></div>
        <div class="stat"><div class="n" style="color:var(--red)">${s.stats?.errors || 0}</div><div class="l">Errors</div></div>
        <div class="stat"><div class="n">${esc(s.status)}</div><div class="l">Status</div></div>
      </div>
      ${metricsHtml}
      <div class="card">
        <div><b>Hostname:</b> ${esc(s.hostname || '—')}</div>
        <div><b>OS:</b> ${esc(s.os || '—')} ${esc(s.os_version || '')}</div>
        <div><b>Agent version:</b> ${esc(s.agent_version || '—')}</div>
        <div><b>Group:</b> ${esc(s.group_name)}</div>
        <div><b>Last seen:</b> ${fmtTime(s.last_seen)}</div>
        <div><b>Sources:</b> ${(s.sources || []).map((x) => `<span class="badge lvl-info">${esc(x)}</span>`).join(' ') || '—'}</div>
      </div>
      <div class="row wrap" style="margin-top:16px">
        <a class="btn" href="#/logs?server_id=${s.id}">View logs</a>
        <button class="btn secondary" id="rotateBtn">Rotate token</button>
        <button class="btn danger" id="delBtn">Delete server</button>
      </div>`;
    document.getElementById('rotateBtn').onclick = async () => {
      if (!confirm('Rotate the token? The current agent will stop ingesting until reconfigured.')) return;
      const r = await api(`/api/v1/servers/${s.id}/rotate`, { method: 'POST' });
      modal(`<h3>New token</h3><div class="dim">Reinstall the agent with:</div><div class="code-box">${esc(r.install_command)}</div><button class="btn" onclick="LW.closeModal()">Done</button>`);
    };
    document.getElementById('delBtn').onclick = async () => {
      if (!confirm(`Delete "${s.name}" and all its logs?`)) return;
      try {
        // POST alias instead of DELETE — some firewalls drop DELETE requests.
        await api(`/api/v1/servers/${s.id}/delete`, { method: 'POST' });
        toast('Server deleted', 'success'); location.hash = '#/dashboard';
      } catch (err) { toast(err.message, 'error'); }
    };
  } catch (err) { toast(err.message, 'error'); }
}

// Multi-line sparkline (CPU/Mem/Disk over time) for the server detail page.
function metricSpark(metrics) {
  if (!metrics || metrics.length < 2) return '<div class="dim">Collecting metrics…</div>';
  const W = 600, H = 90, pad = 4;
  const n = metrics.length;
  const line = (key, color) => {
    const pts = metrics.map((m, i) => {
      const x = pad + (i / (n - 1)) * (W - pad * 2);
      const v = m[key] == null ? 0 : m[key];
      const y = H - pad - (v / 100) * (H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/>`;
  };
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block">
    ${line('cpu', 'var(--blue)')}${line('mem', 'var(--orange)')}${line('disk', 'var(--red)')}
  </svg>
  <div class="dim" style="font-size:11px"><span style="color:var(--blue)">▮</span> CPU · <span style="color:var(--orange)">▮</span> Memory · <span style="color:var(--red)">▮</span> Disk (last ${n} samples)</div>`;
}

// Logs --------------------------------------------------------------------
let ws = null;
function parseQuery() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}
async function renderLogs() {
  if (ws) { ws.close(); ws = null; }
  const initial = parseQuery();
  shell('/logs', `
    <div class="page-head"><h2>Logs</h2><div class="spacer"></div>
      <span class="live-badge off" id="liveBadge">● LIVE OFF</span>
      <button class="btn secondary sm" id="liveBtn">Start live</button>
    </div>
    <div class="toolbar">
      <input class="search" id="q" placeholder="Full-text search… (e.g. Failed password)" value="${esc(initial.q || '')}" />
      <select id="server_id"><option value="">All servers</option></select>
      <select id="level"><option value="">Any level</option></select>
      <select id="source"><option value="">Any source</option></select>
      <select id="sortDir">
        <option value="desc">Newest first</option>
        <option value="asc">Oldest first</option>
      </select>
      <button class="btn" id="searchBtn">Search</button>
      <button class="btn secondary" id="aiSearchBtn" title="Natural-language search">✨ Ask</button>
      <button class="btn secondary" id="exportBtn">⭳ CSV</button>
    </div>
    <div class="log-list" id="logList"><div style="padding:14px" class="dim">Loading…</div></div>`);

  const [servers, facets] = await Promise.all([api('/api/v1/servers'), api('/api/v1/logs/facets')]);
  const sel = (id) => document.getElementById(id);
  sel('server_id').innerHTML += servers.map((s) => `<option value="${s.id}" ${String(s.id) === initial.server_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  sel('level').innerHTML += facets.levels.map((l) => `<option value="${l}" ${l === initial.level ? 'selected' : ''}>${l}+</option>`).join('');
  sel('source').innerHTML += facets.sources.map((s) => `<option value="${esc(s)}" ${s === initial.source ? 'selected' : ''}>${esc(s)}</option>`).join('');

  // Structured-field filter comes via the URL (clicking a field chip).
  const fieldFilter = (initial.field && initial.fieldval !== undefined)
    ? { field: initial.field, fieldval: initial.fieldval } : null;
  if (fieldFilter) {
    const bar = document.querySelector('.toolbar');
    const chip = document.createElement('span');
    chip.className = 'live-badge';
    chip.style.cssText = 'background:var(--accent2,var(--blue));cursor:pointer';
    chip.textContent = `${fieldFilter.field}=${fieldFilter.fieldval} ✕`;
    chip.title = 'Remove field filter';
    chip.onclick = () => { location.hash = '#/logs'; };
    bar.appendChild(chip);
  }

  async function doSearch() {
    const params = new URLSearchParams();
    for (const k of ['q', 'server_id', 'level', 'source']) { const v = sel(k).value.trim(); if (v) params.set(k, v); }
    if (fieldFilter) { params.set('field', fieldFilter.field); params.set('fieldval', fieldFilter.fieldval); }
    if (initial.fp) params.set('fp', initial.fp);
    params.set('sort', sel('sortDir').value);
    params.set('limit', '300');
    try {
      const { logs } = await api(`/api/v1/logs?${params}`);
      renderLogRows(logs);
    } catch (err) { toast(err.message, 'error'); }
  }
  sel('searchBtn').onclick = doSearch;
  sel('sortDir').onchange = doSearch;
  sel('q').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  sel('aiSearchBtn').onclick = async () => {
    if (!window._ai?.enabled) return toast('AI not configured (set ANTHROPIC_API_KEY on the panel)', 'error');
    const query = prompt('Ask in plain language, e.g. "failed SSH logins in the last hour"');
    if (!query) return;
    try {
      const { params } = await api('/api/v1/ai/search', { method: 'POST', body: { query } });
      if (params.q) sel('q').value = params.q;
      if (params.level) sel('level').value = params.level;
      if (params.source && [...sel('source').options].some((o) => o.value === params.source)) sel('source').value = params.source;
      toast('Applied AI filter', 'success');
      doSearch();
    } catch (err) { toast(err.message, 'error'); }
  };
  sel('exportBtn').onclick = () => {
    const params = new URLSearchParams();
    for (const k of ['q', 'server_id', 'level', 'source']) { const v = sel(k).value.trim(); if (v) params.set(k, v); }
    params.set('sort', sel('sortDir').value);
    downloadWithAuth(`/api/v1/logs/export.csv?${params}`, 'logwatch-logs.csv');
  };

  // Click a row to open the detail view with a suggested fix.
  document.getElementById('logList').addEventListener('click', (e) => {
    const row = e.target.closest('.log-row[data-id]');
    if (!row) return;
    const entry = window._logMap?.get(row.dataset.id);
    if (entry) logDetailModal(entry);
  });

  document.getElementById('liveBtn').onclick = () => toggleLive(servers);
  doSearch();
}

function logRowHtml(l) {
  const lvl = l.level || 'info';
  if (!window._logMap) window._logMap = new Map();
  if (l.id != null) window._logMap.set(String(l.id), l);
  return `<div class="log-row" data-id="${l.id ?? ''}" title="Click for details & suggested fix">
    <span class="ts">${fmtTime(l.ts)}</span>
    <span><span class="badge lvl-${lvl}">${lvl}</span></span>
    <span class="src" title="${esc(l.source)}">${esc(l.source || '')}</span>
    <span class="svc" title="${esc(l.service)}">${esc(l.service || '')}</span>
    <span class="msg">${esc(l.message)}</span>
  </div>`;
}
function renderLogRows(logs) {
  window._logMap = new Map();
  const head = `<div class="log-row log-head"><span>Time</span><span>Level</span><span>Source</span><span>Service</span><span>Message</span></div>`;
  document.getElementById('logList').innerHTML = head + (logs.length ? logs.map(logRowHtml).join('') : '<div style="padding:14px" class="dim">No matching logs.</div>');
}

// Detail view for a single log entry, including a suggested fix when the
// message matches a known error pattern.
function logDetailModal(l) {
  const fix = suggestFix(l);
  const fixHtml = fix
    ? `<div class="card" style="margin-top:12px;border-color:var(--accent)">
        <b>💡 ${esc(fix.title)}</b>
        <div class="dim" style="margin:4px 0 8px">${esc(fix.why)}</div>
        <ol style="margin:0;padding-left:18px">${fix.steps.map((s) => `<li style="margin-bottom:4px"><span class="mono">${esc(s)}</span></li>`).join('')}</ol>
      </div>`
    : `<div class="dim" style="margin-top:12px">No specific suggestion for this entry.</div>`;
  const fields = l.fields && typeof l.fields === 'object' ? l.fields : null;
  const fieldsHtml = fields ? `<div style="margin:8px 0"><div class="l dim">EXTRACTED FIELDS (click to filter)</div>
    <div class="row wrap" style="margin-top:4px">${Object.entries(fields).map(([k, v]) =>
      `<button class="badge lvl-info" style="cursor:pointer;border:none" onclick="LW.fieldFilter(${JSON.stringify(k).replace(/"/g, '&quot;')}, ${JSON.stringify(String(v)).replace(/"/g, '&quot;')})">${esc(k)}=${esc(String(v).slice(0, 40))}</button>`
    ).join(' ')}</div></div>` : '';
  modal(`<h3>Log entry</h3>
    <div class="server-meta" style="margin-bottom:8px">
      <div><b>Time:</b> ${fmtTime(l.ts)}</div>
      <div><b>Server:</b> ${esc(l.server_name || l.host || '—')}</div>
      <div><b>Source:</b> ${esc(l.source || '—')} · <b>Service:</b> ${esc(l.service || '—')}</div>
      <div><b>Level:</b> <span class="badge lvl-${l.level || 'info'}">${esc(l.level || 'info')}</span></div>
    </div>
    <div class="code-box">${esc(l.message)}</div>
    ${fieldsHtml}
    ${fixHtml}
    <div class="row" style="margin-top:12px">
      <button class="btn secondary sm" id="copyMsg">Copy message</button>
      ${window._ai?.enabled ? `<button class="btn sm" id="aiExplain">✨ Explain with AI</button>` : ''}
      <button class="btn" onclick="LW.closeModal()">Close</button>
    </div>
    <div id="aiOut" style="margin-top:12px"></div>`);
  document.getElementById('copyMsg').onclick = () => { navigator.clipboard.writeText(l.message); toast('Copied', 'success'); };
  const aiBtn = document.getElementById('aiExplain');
  if (aiBtn) aiBtn.onclick = async () => {
    aiBtn.disabled = true; aiBtn.textContent = 'Thinking…';
    const out = document.getElementById('aiOut');
    out.innerHTML = '<div class="dim">Asking Claude…</div>';
    try {
      const r = await api('/api/v1/ai/explain', { method: 'POST', body: l.id ? { id: l.id } : { message: l.message } });
      out.innerHTML = `<div class="card" style="border-color:var(--accent)">${mdLite(r.explanation)}</div>`;
    } catch (err) { out.innerHTML = `<div class="dim" style="color:var(--red)">${esc(err.message)}</div>`; }
    aiBtn.disabled = false; aiBtn.textContent = '✨ Explain with AI';
  };
}

// Minimal Markdown → HTML (bold, code, line breaks) for AI output.
function mdLite(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<span class="mono" style="background:var(--bg);padding:1px 4px;border-radius:4px">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}

function toggleLive() {
  const badge = document.getElementById('liveBadge');
  const btn = document.getElementById('liveBtn');
  if (ws) { ws.close(); ws = null; badge.className = 'live-badge off'; badge.textContent = '● LIVE OFF'; btn.textContent = 'Start live'; return; }
  const params = new URLSearchParams({ token: getToken() });
  for (const k of ['server_id', 'level', 'source']) { const v = document.getElementById(k).value.trim(); if (v) params.set(k, v); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/v1/stream?${params}`);
  ws.onopen = () => { badge.className = 'live-badge'; badge.textContent = '● LIVE'; btn.textContent = 'Stop live'; };
  ws.onclose = () => { if (ws) { badge.className = 'live-badge off'; badge.textContent = '● LIVE OFF'; btn.textContent = 'Start live'; ws = null; } };
  ws.onmessage = (ev) => {
    const entry = JSON.parse(ev.data);
    if (entry._type) return;
    const list = document.getElementById('logList');
    if (!list) return;
    const div = document.createElement('div');
    div.innerHTML = logRowHtml(entry);
    const headEl = list.querySelector('.log-head');
    if (headEl) headEl.after(div.firstChild); else list.prepend(div.firstChild);
    while (list.children.length > 400) list.lastChild.remove();
  };
}

// Insights: log pattern clustering + threat sources -----------------------
async function renderInsights() {
  shell('/insights', `<div class="page-head"><h2>Insights</h2><div class="spacer"></div>
    <select id="insHours"><option value="24">Last 24h</option><option value="6">Last 6h</option><option value="168">Last 7d</option></select></div>
    <h3>🧩 Top log patterns <span class="dim" style="font-weight:400">— millions of lines grouped into templates</span></h3>
    <div id="patterns">Loading…</div>
    <h3 style="margin-top:24px">🌍 Threat sources <span class="dim" style="font-weight:400">— external IPs in auth/access logs</span></h3>
    <div id="threats">Loading…</div>`);
  const load = async () => {
    const hours = document.getElementById('insHours').value;
    try {
      const [pat, threats] = await Promise.all([
        api(`/api/v1/logs/patterns?hours=${hours}`),
        api(`/api/v1/threats?hours=${hours}`),
      ]);
      document.getElementById('patterns').innerHTML = pat.patterns.length ? `<table class="grid">
        <tr><th>Count</th><th>Level</th><th>Pattern (sample)</th><th>Last</th></tr>
        ${pat.patterns.map((p) => `<tr style="cursor:pointer" onclick="LW.patternLogs(${JSON.stringify(p.fp).replace(/"/g, '&quot;')})">
          <td><b>${p.count}</b></td><td><span class="badge lvl-${p.level || 'info'}">${esc(p.level || '')}</span></td>
          <td class="mono">${esc((p.sample || '').slice(0, 140))}</td><td class="dim">${fmtAgo(p.last_seen)}</td></tr>`).join('')}
        </table>` : '<div class="dim">No patterns yet.</div>';
      document.getElementById('threats').innerHTML = threats.top.length ? `<div class="dim" style="margin-bottom:6px">${threats.total_sources} external sources seen.</div>
        <table class="grid"><tr><th>IP</th><th>Hits</th><th>Suspicious</th><th>Sample</th><th></th></tr>
        ${threats.top.map((t) => `<tr><td class="mono">${esc(t.ip)}</td><td>${t.count}</td>
          <td>${t.suspicious ? `<span style="color:var(--red)">${t.suspicious}</span>` : '0'}</td>
          <td class="mono">${esc((t.sample || '').slice(0, 80))}</td>
          <td><a class="btn secondary sm" href="#/logs?q=${encodeURIComponent(t.ip)}">Logs</a></td></tr>`).join('')}</table>`
        : '<div class="dim">No external threat sources detected.</div>';
    } catch (err) { toast(err.message, 'error'); }
  };
  document.getElementById('insHours').onchange = load;
  load();
}

// Alerts (rules + channels + events) -------------------------------------
async function renderAlerts() {
  shell('/alerts', `<div class="page-head"><h2>Alerts</h2></div>
    <div class="row" style="margin-bottom:16px"><button class="btn" id="addRule">+ Add rule</button><button class="btn secondary" id="addChan">+ Add channel</button></div>
    <h3>Notification channels</h3><div id="chans">Loading…</div>
    <h3 style="margin-top:24px">Rules</h3><div id="rules">Loading…</div>
    <h3 style="margin-top:24px">Recent alert events</h3><div id="events">Loading…</div>`);
  document.getElementById('addRule').onclick = () => ruleModal();
  document.getElementById('addChan').onclick = () => channelModal();
  await reloadAlerts();
}

async function reloadAlerts() {
  const [chans, rules, events] = await Promise.all([
    api('/api/v1/channels'), api('/api/v1/rules'), api('/api/v1/alerts/events?limit=50'),
  ]);
  window._chans = chans;
  document.getElementById('chans').innerHTML = chans.length ? `<table class="grid"><tr><th>Name</th><th>Type</th><th>Enabled</th><th></th></tr>${chans.map((c) => `
    <tr><td>${esc(c.name)}</td><td>${esc(c.type)}</td><td>${c.enabled ? '✅' : '—'}</td>
    <td class="row"><button class="btn secondary sm" onclick="LW.testChan(${c.id})">Test</button>
    <button class="btn danger sm" onclick="LW.delChan(${c.id})">Delete</button></td></tr>`).join('')}</table>`
    : '<div class="dim">No channels. Add Discord, Gotify, Telegram or SMTP.</div>';

  document.getElementById('rules').innerHTML = rules.length ? `<table class="grid"><tr><th>Name</th><th>Match</th><th>Window</th><th>Channel</th><th>On</th><th></th></tr>${rules.map((r) => `
    <tr><td>${esc(r.name)}</td>
    <td class="mono">${esc(r.match_type)}: ${esc(r.pattern || r.min_level || '')}</td>
    <td>${r.window_seconds ? `${r.threshold}/${r.window_seconds}s` : 'each'}</td>
    <td>${(chans.find((c) => c.id === r.channel_id) || {}).name || '—'}</td>
    <td>${r.enabled ? '✅' : '—'}</td>
    <td class="row"><button class="btn secondary sm" onclick='LW.editRule(${r.id})'>Edit</button>
    <button class="btn danger sm" onclick="LW.delRule(${r.id})">Delete</button></td></tr>`).join('')}</table>` : '<div class="dim">No rules.</div>';
  window._rules = rules;

  document.getElementById('events').innerHTML = events.length ? `<table class="grid"><tr><th>Time</th><th>Rule</th><th>Server</th><th>Level</th><th>Message</th><th></th></tr>${events.map((e) => `
    <tr><td>${fmtTime(e.fired_at)}</td><td>${esc(e.rule_name || 'system')}</td><td>${esc(e.server_name || '—')}</td>
    <td><span class="badge lvl-${e.level || 'info'}">${esc(e.level || '')}</span></td><td class="mono">${esc((e.message || '').slice(0, 160))}</td>
    <td>${e.acknowledged ? `<span class="dim" title="by ${esc(e.acknowledged_by || '')}">✔ ack</span>` : `<button class="btn secondary sm" onclick="LW.ackAlert(${e.id})">Ack</button>`}</td></tr>`).join('')}</table>`
    : '<div class="dim">No alerts fired yet.</div>';
}

const CHANNEL_FIELDS = {
  discord: [['webhook_url', 'Webhook URL'], ['username', 'Bot username (optional)']],
  gotify: [['url', 'Gotify URL'], ['token', 'App token']],
  telegram: [['bot_token', 'Bot token'], ['chat_id', 'Chat ID']],
  smtp: [['host', 'SMTP host'], ['port', 'Port'], ['from', 'From'], ['to', 'To'], ['user', 'User (optional)'], ['pass', 'Password (optional)']],
  slack: [['webhook_url', 'Slack incoming webhook URL']],
  teams: [['webhook_url', 'Microsoft Teams webhook URL']],
  pagerduty: [['routing_key', 'PagerDuty Events API v2 routing key']],
  opsgenie: [['api_key', 'Opsgenie API key'], ['eu', 'EU region? true/false (optional)']],
};
function channelModal() {
  const types = Object.keys(CHANNEL_FIELDS);
  modal(`<h3>Add notification channel</h3>
    <div class="form-grid">
      <label>Name<input id="cName" placeholder="My Discord" /></label>
      <label>Type<select id="cType">${types.map((t) => `<option>${t}</option>`).join('')}</select></label>
      <div id="cFields"></div>
      <div class="row"><button class="btn" id="cSave">Save</button><button class="btn secondary" onclick="LW.closeModal()">Cancel</button></div>
    </div>`);
  const renderFields = () => {
    const t = document.getElementById('cType').value;
    document.getElementById('cFields').innerHTML = CHANNEL_FIELDS[t].map(([k, label]) => `<label>${label}<input data-k="${k}" /></label>`).join('');
  };
  document.getElementById('cType').onchange = renderFields; renderFields();
  document.getElementById('cSave').onclick = async () => {
    const type = document.getElementById('cType').value;
    const config = {};
    document.querySelectorAll('#cFields input').forEach((i) => { if (i.value.trim()) config[i.dataset.k] = i.value.trim(); });
    try {
      await api('/api/v1/channels', { method: 'POST', body: { name: document.getElementById('cName').value.trim() || type, type, config } });
      closeModal(); toast('Channel saved', 'success'); reloadAlerts();
    } catch (err) { toast(err.message, 'error'); }
  };
}

function ruleModal(existing) {
  const r = existing || { match_type: 'keyword', window_seconds: 0, threshold: 1, cooldown_seconds: 300, enabled: 1 };
  const chans = window._chans || [];
  modal(`<h3>${existing ? 'Edit' : 'Add'} rule</h3>
    <div class="form-grid">
      <label>Name<input id="rName" value="${esc(r.name || '')}" /></label>
      <label>Match type<select id="rType">${['keyword', 'regex', 'level'].map((t) => `<option ${t === r.match_type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label id="rPatWrap">Pattern<input id="rPattern" value="${esc(r.pattern || '')}" placeholder="e.g. Failed password" /></label>
      <label id="rLvlWrap">Minimum level<select id="rLevel">${['', 'warning', 'error', 'critical'].map((l) => `<option ${l === r.min_level ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Source filter (optional)<input id="rSource" value="${esc(r.source || '')}" placeholder="nginx, kernel, …" /></label>
      <div class="row">
        <label style="flex:1">Threshold<input id="rThreshold" type="number" min="1" value="${r.threshold || 1}" /></label>
        <label style="flex:1">Window (s, 0=each)<input id="rWindow" type="number" min="0" value="${r.window_seconds || 0}" /></label>
        <label style="flex:1">Cooldown (s)<input id="rCooldown" type="number" min="0" value="${r.cooldown_seconds || 300}" /></label>
      </div>
      <label>Channel<select id="rChannel"><option value="">— none (log only) —</option>${chans.map((c) => `<option value="${c.id}" ${c.id === r.channel_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>Quiet hours (e.g. 22-7, suppress overnight; blank = always)<input id="rQuiet" value="${esc(r.quiet_hours || '')}" placeholder="22-7" /></label>
      <label class="row"><input type="checkbox" id="rEnabled" ${r.enabled ? 'checked' : ''} style="width:auto"/> Enabled</label>
      <div class="row"><button class="btn" id="rSave">Save</button><button class="btn secondary" onclick="LW.closeModal()">Cancel</button></div>
    </div>`);
  const sync = () => {
    const t = document.getElementById('rType').value;
    document.getElementById('rPatWrap').style.display = t === 'level' ? 'none' : 'grid';
    document.getElementById('rLvlWrap').style.display = t === 'level' ? 'grid' : 'none';
  };
  document.getElementById('rType').onchange = sync; sync();
  document.getElementById('rSave').onclick = async () => {
    const body = {
      name: document.getElementById('rName').value.trim(),
      match_type: document.getElementById('rType').value,
      pattern: document.getElementById('rPattern').value.trim() || null,
      min_level: document.getElementById('rLevel').value || null,
      source: document.getElementById('rSource').value.trim() || null,
      threshold: Number(document.getElementById('rThreshold').value),
      window_seconds: Number(document.getElementById('rWindow').value),
      cooldown_seconds: Number(document.getElementById('rCooldown').value),
      channel_id: document.getElementById('rChannel').value ? Number(document.getElementById('rChannel').value) : null,
      quiet_hours: document.getElementById('rQuiet').value.trim() || null,
      enabled: document.getElementById('rEnabled').checked,
    };
    try {
      if (existing) await api(`/api/v1/rules/${existing.id}`, { method: 'PUT', body });
      else await api('/api/v1/rules', { method: 'POST', body });
      closeModal(); toast('Rule saved', 'success'); reloadAlerts();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// Settings ----------------------------------------------------------------
async function renderSettings() {
  shell('/settings', `<div class="page-head"><h2>Settings</h2></div><div id="settingsBody">Loading…</div>`);
  const isAdmin = me.role === 'admin';
  const [settings, users, upd] = await Promise.all([
    api('/api/v1/settings'),
    isAdmin ? api('/api/v1/users') : Promise.resolve([]),
    api('/api/v1/system/update').catch(() => null),
  ]);
  const updHtml = upd ? `
    <div class="card" style="margin-bottom:16px">
      <h3>Software update</h3>
      <div>Installed: <b>v${esc(upd.current)}</b>
        ${upd.latest ? ` · Latest on GitHub: <b>v${esc(upd.latest)}</b>` : ''}
        ${upd.error ? ` · <span style="color:var(--orange)">check failed: ${esc(upd.error)}</span>` : ''}
      </div>
      ${upd.update_available
        ? `<div style="margin-top:8px">🚀 <b>Update available.</b></div>
           <div class="row" style="margin-top:8px"><button class="btn" id="applyUpdSettings">⬆ Update now</button></div>
           <div id="updProgress" class="dim" style="margin-top:8px"></div>
           <details style="margin-top:8px"><summary class="dim">Manual command (fallback)</summary>
             <div class="code-box" style="margin-top:6px">${esc(upd.update_command)}</div></details>`
        : `<div class="dim" style="margin-top:6px">${upd.latest ? 'You are up to date.' : 'No version information yet.'}</div>`}
      <div class="row" style="margin-top:10px">
        <button class="btn secondary sm" id="checkUpd">Check now</button>
        <span class="dim">${upd.checked_at ? 'last checked ' + fmtAgo(upd.checked_at) : ''}</span>
      </div>
    </div>` : '';
  document.getElementById('settingsBody').innerHTML = `
    ${updHtml}
    <div class="card" style="margin-bottom:16px">
      <h3>Retention</h3>
      <div class="row"><label class="row">Keep logs for <input id="ret" type="number" min="0" style="width:90px" value="${settings.retention_days || 0}" /> days (0 = forever)</label>
      <button class="btn sm" id="saveRet">Save</button></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <h3>Change password</h3>
      <div class="form-grid" style="max-width:360px">
        <input id="curPw" type="password" placeholder="Current password" />
        <input id="newPw" type="password" placeholder="New password (min 8)" />
        <button class="btn sm" id="savePw">Update password</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <h3>Two-factor authentication (2FA)</h3>
      <div id="twofa">
        ${me.totp_enabled
          ? `<div>Status: <b style="color:var(--green)">enabled</b> ✅</div>
             <div class="row" style="margin-top:8px"><input id="disCode" inputmode="numeric" maxlength="6" placeholder="current 6-digit code" style="width:180px" />
             <button class="btn danger sm" id="disable2fa">Disable 2FA</button></div>`
          : `<div class="dim">Add a second factor (Google Authenticator, Aegis, 1Password, …) to protect your account.</div>
             <button class="btn sm" id="setup2fa" style="margin-top:8px">Set up 2FA</button>`}
      </div>
    </div>
    ${isAdmin ? `<div class="card" style="margin-bottom:16px">
      <h3>Audit log <button class="btn secondary sm" id="auditCsv" style="float:right">⭳ CSV</button></h3>
      <div id="auditBox" class="dim">Loading…</div>
    </div>` : ''}
    ${isAdmin ? `<div class="card">
      <h3>Users</h3>
      <table class="grid"><tr><th>User</th><th>Role</th><th>Last login</th><th></th></tr>
      ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${fmtAgo(u.last_login)}</td>
        <td>${u.id === me.id ? '<span class="dim">you</span>' : `<button class="btn danger sm" onclick="LW.delUser(${u.id})">Delete</button>`}</td></tr>`).join('')}</table>
      <div class="row wrap" style="margin-top:12px">
        <input id="nuName" placeholder="username" />
        <input id="nuPw" type="password" placeholder="password (min 8)" />
        <select id="nuRole"><option value="operator">operator</option><option value="admin">admin</option><option value="viewer">viewer</option></select>
        <button class="btn sm" id="addUser">Add user</button>
      </div>
    </div>` : ''}`;

  const applyBtn = document.getElementById('applyUpdSettings');
  if (applyBtn && upd) applyBtn.onclick = () => applyUpdate(upd.current, 'applyUpdSettings');
  const checkBtn = document.getElementById('checkUpd');
  if (checkBtn) {
    checkBtn.onclick = async () => {
      checkBtn.disabled = true;
      try {
        await api('/api/v1/system/update/check', { method: 'POST' });
        renderSettings();
      } catch (err) { toast(err.message, 'error'); checkBtn.disabled = false; }
    };
  }
  document.getElementById('saveRet').onclick = async () => {
    await api('/api/v1/settings', { method: 'PUT', body: { retention_days: Number(document.getElementById('ret').value) } });
    toast('Saved', 'success');
  };
  document.getElementById('savePw').onclick = async () => {
    try {
      await api('/api/v1/auth/password', { method: 'POST', body: { current_password: document.getElementById('curPw').value, new_password: document.getElementById('newPw').value } });
      toast('Password updated', 'success'); document.getElementById('curPw').value = ''; document.getElementById('newPw').value = '';
    } catch (err) { toast(err.message, 'error'); }
  };

  // 2FA
  document.getElementById('setup2fa')?.addEventListener('click', twoFactorSetupModal);
  document.getElementById('disable2fa')?.addEventListener('click', async () => {
    try {
      await api('/api/v1/auth/2fa/disable', { method: 'POST', body: { totp: document.getElementById('disCode').value.trim() } });
      toast('2FA disabled', 'success'); me.totp_enabled = false; renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Audit log (admin)
  if (isAdmin) {
    document.getElementById('auditCsv').onclick = () => downloadWithAuth('/api/v1/audit/export.csv', 'logwatch-audit.csv');
    api('/api/v1/audit?limit=100').then((rows) => {
      const box = document.getElementById('auditBox');
      box.innerHTML = rows.length ? `<table class="grid"><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>IP</th></tr>${rows.map((r) => `
        <tr><td>${fmtTime(r.ts)}</td><td>${esc(r.username || '—')}</td>
        <td><span class="mono">${esc(r.action)}</span></td><td>${esc(r.target || '')}${r.detail ? ` <span class="dim">${esc(r.detail)}</span>` : ''}</td>
        <td class="mono">${esc(r.ip || '')}</td></tr>`).join('')}</table>` : '<div class="dim">No audit entries yet.</div>';
    }).catch((e) => { document.getElementById('auditBox').textContent = e.message; });
  }
  if (isAdmin) {
    document.getElementById('addUser').onclick = async () => {
      try {
        await api('/api/v1/users', { method: 'POST', body: { username: document.getElementById('nuName').value.trim(), password: document.getElementById('nuPw').value, role: document.getElementById('nuRole').value } });
        toast('User added', 'success'); renderSettings();
      } catch (err) { toast(err.message, 'error'); }
    };
  }
}

// 2FA setup wizard ---------------------------------------------------------
async function twoFactorSetupModal() {
  let data;
  try { data = await api('/api/v1/auth/2fa/setup', { method: 'POST', body: {} }); }
  catch (err) { return toast(err.message, 'error'); }
  // QR via a public chart endpoint is avoided for privacy; show secret + URI.
  modal(`<h3>Set up two-factor authentication</h3>
    <ol style="padding-left:18px">
      <li>Open your authenticator app (Google Authenticator, Aegis, 1Password…).</li>
      <li>Add an account → "enter a setup key" and paste:</li>
    </ol>
    <div class="code-box" style="margin:8px 0">${esc(data.secret)}</div>
    <div class="dim" style="font-size:12px;word-break:break-all">otpauth URI: ${esc(data.otpauth_uri)}</div>
    <div class="form-grid" style="margin-top:12px;max-width:240px">
      <input id="enCode" inputmode="numeric" maxlength="6" placeholder="6-digit code from app" />
      <div class="row"><button class="btn" id="enable2fa">Enable</button><button class="btn secondary" onclick="LW.closeModal()">Cancel</button></div>
    </div>`);
  document.getElementById('enable2fa').onclick = async () => {
    try {
      await api('/api/v1/auth/2fa/enable', { method: 'POST', body: { totp: document.getElementById('enCode').value.trim() } });
      closeModal(); toast('2FA enabled', 'success'); me.totp_enabled = true; renderSettings();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// Modal helpers -----------------------------------------------------------
function modal(html) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-backdrop'; back.id = 'modalBack';
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.onclick = (e) => { if (e.target === back) closeModal(); };
  document.body.appendChild(back);
}
function closeModal() { document.getElementById('modalBack')?.remove(); }

// Global handlers for inline onclick in tables.
Object.assign(window.LW, {
  closeModal,
  testChan: async (id) => { try { await api(`/api/v1/channels/${id}/test`, { method: 'POST' }); toast('Test sent', 'success'); } catch (e) { toast(e.message, 'error'); } },
  delChan: async (id) => { if (confirm('Delete channel?')) { try { await api(`/api/v1/channels/${id}/delete`, { method: 'POST' }); reloadAlerts(); } catch (e) { toast(e.message, 'error'); } } },
  delRule: async (id) => { if (confirm('Delete rule?')) { try { await api(`/api/v1/rules/${id}/delete`, { method: 'POST' }); reloadAlerts(); } catch (e) { toast(e.message, 'error'); } } },
  editRule: (id) => ruleModal((window._rules || []).find((r) => r.id === id)),
  delUser: async (id) => { if (confirm('Delete user?')) { try { await api(`/api/v1/users/${id}/delete`, { method: 'POST' }); renderSettings(); } catch (e) { toast(e.message, 'error'); } } },
  ackAlert: async (id) => { try { await api(`/api/v1/alerts/events/${id}/ack`, { method: 'POST', body: {} }); reloadAlerts(); } catch (e) { toast(e.message, 'error'); } },
  fieldFilter: (k, v) => { closeModal(); location.hash = `#/logs?field=${encodeURIComponent(k)}&fieldval=${encodeURIComponent(v)}`; },
  patternLogs: (fp) => { location.hash = `#/logs?fp=${encodeURIComponent(fp)}`; },
});
