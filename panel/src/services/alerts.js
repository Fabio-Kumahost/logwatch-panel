// Alert rule engine. Evaluates each incoming log entry against enabled rules,
// applies frequency-window + cooldown logic and dispatches notifications.
import { db } from '../db/index.js';
import { LEVEL_RANK } from '../utils/normalize.js';
import { sendToChannel } from './notifier.js';

let rulesCache = [];
let channelsCache = new Map();
const regexCache = new Map();
// Per-rule rolling match timestamps for frequency windows.
const windowHits = new Map();

export function reloadRules() {
  rulesCache = db.prepare('SELECT * FROM rules WHERE enabled = 1').all();
  const chans = db.prepare('SELECT * FROM channels WHERE enabled = 1').all();
  channelsCache = new Map(chans.map((c) => [c.id, c]));
}

function getRegex(rule) {
  if (regexCache.has(rule.id)) return regexCache.get(rule.id);
  let re = null;
  try {
    if ((rule.pattern || '').length <= 512) re = new RegExp(rule.pattern, 'i');
  } catch {
    re = null; // invalid regex → never matches
  }
  regexCache.set(rule.id, re);
  return re;
}

export function invalidateRegex(ruleId) {
  regexCache.delete(ruleId);
}

function ruleMatchesEntry(rule, entry, server) {
  if (rule.server_id && rule.server_id !== entry.server_id) return false;
  if (rule.server_group && rule.server_group !== (server?.group_name || 'default')) return false;
  if (rule.source && rule.source !== entry.source) return false;

  if (rule.match_type === 'level') {
    const want = LEVEL_RANK[rule.min_level] ?? 99;
    return (LEVEL_RANK[entry.level] ?? 0) >= want;
  }
  if (rule.match_type === 'keyword') {
    if (!rule.pattern) return false;
    return entry.message.toLowerCase().includes(rule.pattern.toLowerCase());
  }
  if (rule.match_type === 'regex') {
    const re = getRegex(rule);
    return re ? re.test(entry.message) : false;
  }
  return false;
}

function shouldFire(rule, nowSec) {
  // Cooldown gate.
  if (rule.last_fired_at && nowSec - rule.last_fired_at < rule.cooldown_seconds) return false;

  // Simple mode: fire on every match.
  if (!rule.window_seconds || rule.window_seconds <= 0 || rule.threshold <= 1) return true;

  // Frequency mode: count matches within the rolling window.
  let hits = windowHits.get(rule.id) || [];
  hits.push(nowSec);
  const cutoff = nowSec - rule.window_seconds;
  hits = hits.filter((t) => t >= cutoff);
  windowHits.set(rule.id, hits);
  return hits.length >= rule.threshold;
}

async function fire(rule, entry, server) {
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE rules SET last_fired_at = ? WHERE id = ?').run(nowSec, rule.id);
  rule.last_fired_at = nowSec;
  windowHits.set(rule.id, []); // reset window after firing
  db.prepare(
    'INSERT INTO alert_events(rule_id, server_id, level, message) VALUES(?,?,?,?)'
  ).run(rule.id, entry.server_id, entry.level, entry.message.slice(0, 2000));

  const channel = rule.channel_id ? channelsCache.get(rule.channel_id) : null;
  if (!channel) return; // recorded but no delivery target
  try {
    await sendToChannel(channel, {
      title: rule.name,
      level: entry.level,
      message: entry.message,
      server: server?.name || `#${entry.server_id}`,
      source: entry.source,
      rule: rule.name,
    });
  } catch (err) {
    console.error(`[alerts] delivery failed for rule "${rule.name}": ${err.message}`);
  }
}

// Evaluate a batch of entries for one server. Called from ingest.
export async function evaluate(entries, server) {
  if (rulesCache.length === 0) return;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    for (const rule of rulesCache) {
      if (!ruleMatchesEntry(rule, entry, server)) continue;
      if (shouldFire(rule, nowSec)) {
        await fire(rule, entry, server);
      }
    }
  }
}

// Used by heartbeat/system alerts (agent offline, no logs) — sends to a channel.
export async function dispatchSystemAlert(alert) {
  let channel = null;
  const setId = db.prepare("SELECT value FROM settings WHERE key='alert_channel_id'").get();
  if (setId?.value) channel = channelsCache.get(Number(setId.value));
  if (!channel) channel = [...channelsCache.values()][0];
  db.prepare(
    'INSERT INTO alert_events(rule_id, server_id, level, message) VALUES(NULL,?,?,?)'
  ).run(alert.serverId || null, alert.level || 'warning', alert.message.slice(0, 2000));
  if (!channel) return;
  try {
    await sendToChannel(channel, {
      title: alert.title,
      level: alert.level || 'warning',
      message: alert.message,
      server: alert.server,
      source: 'panel',
      rule: 'system',
    });
  } catch (err) {
    console.error(`[alerts] system alert delivery failed: ${err.message}`);
  }
}

// Seed a useful default rule set on first run (idempotent: only if no rules).
export function seedDefaultRules() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM rules').get().n;
  if (count > 0) return;
  const ins = db.prepare(
    `INSERT INTO rules(name, match_type, pattern, min_level, source, window_seconds, threshold, cooldown_seconds)
     VALUES(@name,@match_type,@pattern,@min_level,@source,@window_seconds,@threshold,@cooldown_seconds)`
  );
  const defaults = [
    { name: 'Critical events', match_type: 'level', pattern: null, min_level: 'critical', source: null, window_seconds: 0, threshold: 1, cooldown_seconds: 120 },
    { name: 'Errors', match_type: 'level', pattern: null, min_level: 'error', source: null, window_seconds: 0, threshold: 1, cooldown_seconds: 300 },
    { name: 'Failed login', match_type: 'regex', pattern: 'Failed password|authentication failure|Invalid user', min_level: null, source: null, window_seconds: 0, threshold: 1, cooldown_seconds: 300 },
    { name: 'SSH brute force', match_type: 'regex', pattern: 'Failed password|Invalid user', min_level: null, source: null, window_seconds: 60, threshold: 5, cooldown_seconds: 600 },
    { name: 'Kernel errors', match_type: 'regex', pattern: 'kernel:.*(error|panic|oops|segfault)|Out of memory|oom-kill', min_level: null, source: null, window_seconds: 0, threshold: 1, cooldown_seconds: 300 },
    { name: 'Service crashed', match_type: 'regex', pattern: 'Main process exited|failed with result|core-dumped|segfault', min_level: null, source: null, window_seconds: 0, threshold: 1, cooldown_seconds: 300 },
    { name: 'Disk full', match_type: 'keyword', pattern: 'No space left on device', min_level: null, source: null, window_seconds: 0, threshold: 1, cooldown_seconds: 600 },
  ];
  const tx = db.transaction(() => defaults.forEach((d) => ins.run(d)));
  tx();
}
