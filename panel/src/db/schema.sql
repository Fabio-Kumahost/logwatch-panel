-- LogWatch Panel database schema (SQLite).
-- All statements are idempotent (IF NOT EXISTS) so they can run on every boot.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Panel users (admins / operators). Roles prepare a simple RBAC system.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_login    INTEGER
);

-- Registered servers. Each server authenticates its agent with a bearer token;
-- only the SHA-256 hash of the token is stored.
CREATE TABLE IF NOT EXISTS servers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  group_name  TEXT NOT NULL DEFAULT 'default',
  hostname    TEXT,
  os          TEXT,
  os_version  TEXT,
  agent_version TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','online','offline')),
  last_seen   INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Collected log entries.
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,            -- event time (unix seconds, from source if available)
  received_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  source      TEXT,                        -- e.g. journal, syslog, nginx, docker
  service     TEXT,                        -- unit / program name
  level       TEXT,                        -- normalized: debug,info,notice,warning,error,critical
  host        TEXT,
  message     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_server_ts ON logs(server_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_ts        ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level     ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_source    ON logs(source);
CREATE INDEX IF NOT EXISTS idx_logs_service   ON logs(service);

-- Full-text search index over messages (external-content FTS5 mirror of logs).
CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
  message,
  service,
  source,
  content='logs',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS logs_ai AFTER INSERT ON logs BEGIN
  INSERT INTO logs_fts(rowid, message, service, source)
  VALUES (new.id, new.message, new.service, new.source);
END;
CREATE TRIGGER IF NOT EXISTS logs_ad AFTER DELETE ON logs BEGIN
  INSERT INTO logs_fts(logs_fts, rowid, message, service, source)
  VALUES ('delete', old.id, old.message, old.service, old.source);
END;

-- Notification channels (Discord, Gotify, SMTP, Telegram).
CREATE TABLE IF NOT EXISTS channels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('discord','gotify','smtp','telegram')),
  config     TEXT NOT NULL,               -- JSON, secrets included (file is chmod 600)
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Alert rules evaluated against incoming logs.
CREATE TABLE IF NOT EXISTS rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  match_type     TEXT NOT NULL CHECK (match_type IN ('keyword','regex','level')),
  pattern        TEXT,                     -- keyword or regex (for level matches: unused)
  min_level      TEXT,                     -- for match_type=level: trigger at/above this level
  source         TEXT,                     -- optional source filter
  server_group   TEXT,                     -- optional group filter
  server_id      INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  window_seconds INTEGER NOT NULL DEFAULT 0,   -- frequency window (0 = trigger on every match)
  threshold      INTEGER NOT NULL DEFAULT 1,   -- N matches within window to fire
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  channel_id     INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  last_fired_at  INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Audit log of fired alerts.
CREATE TABLE IF NOT EXISTS alert_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id   INTEGER REFERENCES rules(id) ON DELETE CASCADE,
  server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  level     TEXT,
  message   TEXT,
  fired_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Key/value settings (retention overrides, etc.).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Security audit trail: who did what, from where.
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  user_id   INTEGER,
  username  TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  detail    TEXT,
  ip        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
