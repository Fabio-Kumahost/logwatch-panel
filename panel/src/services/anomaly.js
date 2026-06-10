// Statistical anomaly detection (no ML): flags never-before-seen error patterns
// and unusual spikes in the error rate. Runs on an interval.
import { db, getSetting } from '../db/index.js';
import { dispatchSystemAlert } from './alerts.js';

const CHECK_MS = 5 * 60 * 1000;
let lastCheck = Math.floor(Date.now() / 1000);
let lastSpikeAlert = 0;

function enabled() {
  return getSetting('anomaly_enabled', '1') !== '0';
}

// Seed every existing error/critical fingerprint as "known" so the first run
// doesn't alert on the entire backlog.
function warmup() {
  const known = db.prepare('SELECT COUNT(*) AS n FROM seen_patterns').get().n;
  if (known > 0) return;
  db.prepare(
    `INSERT OR IGNORE INTO seen_patterns(fp, level, sample)
     SELECT fp, level, MAX(message) FROM logs
     WHERE fp IS NOT NULL AND level IN ('error','critical') GROUP BY fp`
  ).run();
}

function detectNewErrors(nowSec) {
  const rows = db.prepare(
    `SELECT l.fp, l.level, l.message, l.server_id, s.name AS server_name
     FROM logs l LEFT JOIN servers s ON s.id = l.server_id
     WHERE l.received_at >= ? AND l.level IN ('error','critical') AND l.fp IS NOT NULL
       AND l.fp NOT IN (SELECT fp FROM seen_patterns)
     GROUP BY l.fp LIMIT 50`
  ).all(lastCheck);
  const ins = db.prepare('INSERT OR IGNORE INTO seen_patterns(fp, level, sample) VALUES(?,?,?)');
  let alerted = 0;
  for (const r of rows) {
    ins.run(r.fp, r.level, r.message.slice(0, 500));
    if (alerted < 5) { // cap alert volume per run
      alerted++;
      dispatchSystemAlert({
        title: 'New error pattern',
        level: r.level === 'critical' ? 'critical' : 'error',
        serverId: r.server_id,
        server: r.server_name || `#${r.server_id}`,
        message: `A never-before-seen ${r.level} appeared on "${r.server_name || r.server_id}":\n${r.message}`,
      }).catch(() => {});
    }
  }
  return rows.length;
}

function detectSpike(nowSec) {
  if (nowSec - lastSpikeAlert < 3600) return; // 1h cooldown
  const bucketNow = Math.floor(nowSec / 3600);
  const rows = db.prepare(
    `SELECT (received_at/3600) AS bucket, COUNT(*) AS n
     FROM logs WHERE level IN ('error','critical') AND received_at >= ?
     GROUP BY bucket`
  ).all((bucketNow - 7) * 3600);
  const byBucket = new Map(rows.map((r) => [r.bucket, r.n]));
  const current = byBucket.get(bucketNow) || 0;
  const baseline = [];
  for (let b = bucketNow - 6; b < bucketNow; b++) baseline.push(byBucket.get(b) || 0);
  const mean = baseline.reduce((a, v) => a + v, 0) / baseline.length;
  const variance = baseline.reduce((a, v) => a + (v - mean) ** 2, 0) / baseline.length;
  const std = Math.sqrt(variance);
  // Alert when the current hour is far above the recent baseline.
  if (current >= 10 && current > mean + 3 * Math.max(std, 1) && current > mean * 2) {
    lastSpikeAlert = nowSec;
    dispatchSystemAlert({
      title: 'Error rate spike',
      level: 'warning',
      message: `Error/critical logs spiked to ${current} this hour vs a baseline of ~${mean.toFixed(1)}/h.`,
    }).catch(() => {});
  }
}

export function runOnce() {
  if (!enabled()) return;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    detectNewErrors(nowSec);
    detectSpike(nowSec);
  } finally {
    lastCheck = nowSec;
  }
}

export function startAnomaly(logger) {
  try { warmup(); } catch (err) { logger?.error?.(`[anomaly] warmup: ${err.message}`); }
  const timer = setInterval(() => {
    try { runOnce(); } catch (err) { logger?.error?.(`[anomaly] ${err.message}`); }
  }, CHECK_MS);
  timer.unref();
  return timer;
}
