// Background pruning of old logs based on the configurable retention window.
import { db, getSetting } from '../db/index.js';
import { config } from '../config.js';

export function pruneOnce() {
  const days = parseInt(getSetting('retention_days', String(config.retentionDays)), 10);
  if (!Number.isFinite(days) || days <= 0) return 0; // keep forever
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const info = db.prepare('DELETE FROM logs WHERE received_at < ?').run(cutoff);
  if (info.changes > 0) {
    db.prepare('DELETE FROM alert_events WHERE fired_at < ?').run(cutoff);
  }
  return info.changes;
}

export function startRetention(logger) {
  const run = () => {
    try {
      const removed = pruneOnce();
      if (removed > 0) logger?.info(`[retention] pruned ${removed} old log rows`);
    } catch (err) {
      logger?.error(`[retention] ${err.message}`);
    }
  };
  run();
  const timer = setInterval(run, config.retentionSweepMinutes * 60 * 1000);
  timer.unref();
  return timer;
}
