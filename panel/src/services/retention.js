// Background pruning of old logs based on the configurable retention window.
// Deletes happen in chunks that yield between batches: better-sqlite3 is
// synchronous, and one huge DELETE would block the event loop and make the
// whole panel unresponsive.
import { db, getSetting } from '../db/index.js';
import { config } from '../config.js';

const CHUNK = 10000;

export async function pruneOnce() {
  const days = parseInt(getSetting('retention_days', String(config.retentionDays)), 10);
  if (!Number.isFinite(days) || days <= 0) return 0; // keep forever
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const chunk = db.prepare(
    'DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE received_at < ? LIMIT ?)'
  );
  let total = 0;
  for (;;) {
    const { changes } = chunk.run(cutoff, CHUNK);
    total += changes;
    if (changes < CHUNK) break;
    await new Promise((resolve) => setImmediate(resolve)); // yield to requests
  }
  if (total > 0) {
    db.prepare('DELETE FROM alert_events WHERE fired_at < ?').run(cutoff);
  }
  return total;
}

export function startRetention(logger) {
  const run = async () => {
    try {
      const removed = await pruneOnce();
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
