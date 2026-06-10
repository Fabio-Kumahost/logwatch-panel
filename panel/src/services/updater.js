// Periodically checks GitHub for a newer panel version and exposes the result
// so the UI can suggest an upgrade. Compares the local package.json version
// against the one on the repository's main branch (works without releases).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const REPO = 'Fabio-Kumahost/logwatch-panel';
const REMOTE_PKG = `https://raw.githubusercontent.com/${REPO}/main/panel/package.json`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

function localVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const CURRENT_VERSION = localVersion();

// Returns >0 if a is newer than b (simple semver, no prerelease handling).
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

const state = {
  current: CURRENT_VERSION,
  latest: null,
  update_available: false,
  checked_at: null,
  error: null,
};

export async function checkForUpdate(logger) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(REMOTE_PKG, {
      signal: ctrl.signal,
      headers: { 'user-agent': `logwatch-panel/${CURRENT_VERSION}` },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
    const pkg = await res.json();
    state.latest = pkg.version || null;
    state.update_available = !!state.latest && compareVersions(state.latest, CURRENT_VERSION) > 0;
    state.error = null;
    if (state.update_available) {
      logger?.info(`[updater] update available: ${CURRENT_VERSION} -> ${state.latest}`);
    }
  } catch (err) {
    state.error = err.name === 'AbortError' ? 'timeout reaching GitHub' : err.message;
    logger?.warn(`[updater] check failed: ${state.error}`);
  }
  state.checked_at = Math.floor(Date.now() / 1000);
  return { ...state };
}

export function getUpdateStatus() {
  return { ...state };
}

export function startUpdater(logger) {
  checkForUpdate(logger);
  const timer = setInterval(() => checkForUpdate(logger), CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}
