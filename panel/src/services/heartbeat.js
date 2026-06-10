// Marks servers offline when they stop sending logs and emits system alerts
// (agent offline / no logs) — with a per-server cooldown to avoid spam.
import { db } from '../db/index.js';
import { config } from '../config.js';
import { dispatchSystemAlert } from './alerts.js';

const notified = new Map(); // serverId -> last notified unix sec

export function checkOnce() {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - config.agentOfflineSeconds;
  const stale = db
    .prepare("SELECT * FROM servers WHERE status = 'online' AND (last_seen IS NULL OR last_seen < ?)")
    .all(cutoff);
  for (const s of stale) {
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(s.id);
    const last = notified.get(s.id) || 0;
    if (nowSec - last >= config.agentOfflineSeconds) {
      notified.set(s.id, nowSec);
      const since = s.last_seen ? `${nowSec - s.last_seen}s ago` : 'never';
      dispatchSystemAlert({
        title: 'Agent offline',
        level: 'warning',
        serverId: s.id,
        server: s.name,
        message: `Server "${s.name}" (${s.hostname || 'unknown'}) stopped sending logs. Last seen: ${since}.`,
      }).catch(() => {});
    }
  }
  // Clear notification memory for servers that came back.
  for (const id of notified.keys()) {
    const row = db.prepare('SELECT status FROM servers WHERE id = ?').get(id);
    if (!row || row.status === 'online') notified.delete(id);
  }
}

export function startHeartbeat(logger) {
  const run = () => {
    try {
      checkOnce();
    } catch (err) {
      logger?.error(`[heartbeat] ${err.message}`);
    }
  };
  const timer = setInterval(run, config.heartbeatCheckSeconds * 1000);
  timer.unref();
  return timer;
}
