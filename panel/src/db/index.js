// Database access layer. Opens the SQLite database, applies the schema and
// exposes a small set of helpers. Using better-sqlite3 (synchronous) keeps the
// code simple and is plenty fast for the panel's workload.
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dbPath = resolve(process.cwd(), config.dbPath);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Apply schema (idempotent).
const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight column migrations (SQLite lacks ADD COLUMN IF NOT EXISTS).
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('users', 'totp_secret', 'TEXT');
ensureColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
// v1.5: structured fields, syslog source mapping, alert ack, rule quiet hours.
ensureColumn('logs', 'fields', 'TEXT');
ensureColumn('servers', 'ingest_ip', 'TEXT');
ensureColumn('alert_events', 'acknowledged', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('alert_events', 'acknowledged_by', 'TEXT');
ensureColumn('rules', 'quiet_hours', 'TEXT');
// v1.6: log pattern fingerprint for clustering / new-error detection.
ensureColumn('logs', 'fp', 'TEXT');

// v1.5: older databases have a restrictive CHECK on channels.type that rejects
// the new channel types (slack/teams/pagerduty/opsgenie). Rebuild without it.
const chSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='channels'").get();
if (chSql && /CHECK\s*\(\s*type/i.test(chSql.sql)) {
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE channels_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      INSERT INTO channels_new(id,name,type,config,enabled,created_at)
        SELECT id,name,type,config,enabled,created_at FROM channels;
      DROP TABLE channels;
      ALTER TABLE channels_new RENAME TO channels;`);
  });
  db.pragma('foreign_keys = OFF');
  rebuild();
  db.pragma('foreign_keys = ON');
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export default db;
