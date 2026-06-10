# LogWatch Panel — API Reference

Base URL: `${PUBLIC_URL}` (e.g. `https://panel.example.com`). All API routes are
under `/api/v1`. Responses are JSON.

## Authentication

Two auth schemes:

| Caller       | Header                                 | Obtained via |
|--------------|----------------------------------------|--------------|
| Panel users  | `Authorization: Bearer <JWT>`          | `POST /auth/login` |
| Agents       | `Authorization: Bearer <server-token>` | created with a server in the UI / `POST /servers` |

JWTs expire after `JWT_EXPIRY` (default 12h). Server tokens are stored only as a
SHA-256 hash; the plaintext is shown **once** at creation.

---

## Auth

### `POST /api/v1/auth/login`
Rate-limited (default 8 attempts / 5 min per IP).
```json
{ "username": "admin", "password": "secret" }
```
→ `200 { "token": "<jwt>", "user": { "id": 1, "username": "admin", "role": "admin" } }`

### `GET /api/v1/auth/me`  → current user
### `POST /api/v1/auth/password`
```json
{ "current_password": "old", "new_password": "newsecret" }
```

---

## Servers

### `GET /api/v1/servers`
List servers with derived status (`online` / `offline` / `pending`), `last_seen`, `last_log`.

### `POST /api/v1/servers`  *(operator+)*
```json
{ "name": "web-01", "group_name": "web" }
```
→ `201 { "id": 5, "token": "<hex64>", "install_command": "curl -sSL …" }`

### `GET /api/v1/servers/:id` → detail with stats and discovered sources
### `POST /api/v1/servers/:id/rotate` *(operator+)* → new token + install command
### `DELETE /api/v1/servers/:id` *(operator+)*

---

## Log ingest (agent)

### `POST /api/v1/ingest`  *(agent token)*
```json
{
  "host": "web-01", "os": "debian", "os_version": "12", "agent_version": "1.0.0",
  "entries": [
    { "ts": 1718200000, "source": "nginx", "service": "nginx",
      "level": "error", "message": "connect() failed (111: Connection refused)" }
  ]
}
```
`ts` is unix seconds (optional; server time used if absent). `level` is normalized
server-side (syslog severities, journald PRIORITY and common words are mapped).
→ `202 { "accepted": 1 }`. Secrets in messages are masked before storage.

### `POST /api/v1/heartbeat` *(agent token)* → keeps the server marked online when idle.

---

## Logs (query)

### `GET /api/v1/logs`
Query params (all optional):

| Param       | Meaning |
|-------------|---------|
| `q`         | full-text search (FTS5) over message/service/source |
| `server_id` | filter by server |
| `level`     | minimum level (`debug`…`critical`) |
| `source`    | exact source (e.g. `nginx`, `kernel`) |
| `service`   | exact service/unit |
| `from`,`to` | unix-second time range |
| `limit`     | 1–1000 (default 200) |
| `offset`    | pagination |

→ `{ "logs": [ … ], "limit": 200, "offset": 0 }`

### `GET /api/v1/logs/facets` → `{ sources, services, levels }` for filter UIs
### `GET /api/v1/logs/stats` → totals + per-level counts (last 24h)

---

## Live stream

### `GET /api/v1/stream` (WebSocket)
Query: `token=<jwt>` plus optional `server_id`, `level`, `source`, `service`.
Emits one JSON log entry per message.

### `GET /api/v1/stream/sse` (Server-Sent Events) — same filters; fallback transport.

---

## Channels & rules (alerting)

- `GET/POST /api/v1/channels`, `PUT/DELETE /api/v1/channels/:id`, `POST /api/v1/channels/:id/test`
  - types: `discord`, `gotify`, `telegram`, `smtp`. Config keys per type — see `docs/examples`.
- `GET/POST /api/v1/rules`, `PUT/DELETE /api/v1/rules/:id`
  - `match_type`: `keyword` | `regex` | `level`; plus `window_seconds`, `threshold`,
    `cooldown_seconds`, optional `source`/`server_group`/`server_id`, `channel_id`.
- `GET /api/v1/alerts/events?limit=100` → recent fired alerts.

---

## Admin & settings

- `GET/POST/DELETE /api/v1/users` *(admin)* — roles: `admin`, `operator`, `viewer`.
- `GET/PUT /api/v1/settings` — `retention_days`, `alert_channel_id` (for system alerts).

## System / updates

- `GET /api/v1/system/update` → `{ current, latest, update_available, checked_at, error, update_command }`
  — cached result of the 6-hourly GitHub version check.
- `POST /api/v1/system/update/check` *(operator+)* → forces a re-check now.

Note: `DELETE /api/v1/servers/:id` returns immediately; the server's log history is
purged in background chunks so large histories never block the panel.

## Health
### `GET /api/v1/health` → `{ "status": "ok", "version": "<panel version>", "time": <unix> }`

## Agent distribution (public, no auth)
- `GET /agent/install.sh` — the installer script.
- `GET /agent/download/logwatch-agent-linux-<amd64|arm64|armv7|386>` — agent binary.
