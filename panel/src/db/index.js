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
