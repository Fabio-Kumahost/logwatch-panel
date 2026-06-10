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

### `POST /api/v1/ingest/raw` *(agent token)* — foreign sources
For Vector, Fluent Bit, rsyslog (omhttp), OTel collectors. Body:
- `text/plain` — one log line per row
- `application/x-ndjson` — one JSON object per row
- `application/json` — a single object or array

Defaults via query: `?source=…&service=…`. Example (rsyslog/Vector):
```bash
curl -X POST "$PANEL/api/v1/ingest/raw?source=syslog" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: text/plain' \
  --data-binary $'line one\nline two'
```

### `POST /api/v1/metrics` *(agent token)* — host resource metrics
`{ cpu, mem, disk, load1, uptime }` (percentages 0–100). Stored for the server
detail charts; built-in alerts fire at disk ≥ 90% / mem ≥ 95%.

### UDP syslog listener (optional)
Set `SYSLOG_UDP_PORT` (e.g. 5514). Incoming RFC3164/5424 messages are mapped to a
server by **source IP** (`ingest_ip`, set when creating a server). No per-message
auth — only known IPs are accepted.

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
| `sort`      | `desc` (default, newest first) or `asc` |
| `field` + `fieldval` | filter on an extracted structured field (e.g. `field=status&fieldval=500`) |

→ `{ "logs": [ … ], "limit": 200, "offset": 0 }`

### `GET /api/v1/logs/patterns?hours=&server_id=&level=`
Log clustering: groups logs by fingerprint (variables tokenized) into templates,
top patterns first. Filter `/logs` by an exact pattern with `?fp=<fingerprint>`.

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

## SSO (OpenID Connect)
Enabled when `OIDC_ISSUER` + `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` are set.
- `GET /api/v1/auth/oidc/config` → `{ enabled, button_label }`.
- `GET /api/v1/auth/oidc/start` → 302 redirect to the identity provider (PKCE).
- `GET /api/v1/auth/oidc/callback?code&state` → exchanges the code, provisions
  the user (default role `viewer`, optional email-domain allowlist), issues a
  panel JWT and redirects to `<PUBLIC_URL>/#sso=<jwt>` (or `#sso_error=...`).

Register the redirect URI `<PUBLIC_URL>/api/v1/auth/oidc/callback` at the provider.

## Two-factor auth (TOTP)
- `POST /api/v1/auth/2fa/setup` → `{ secret, otpauth_uri }` (not yet active).
- `POST /api/v1/auth/2fa/enable` `{ totp }` → activates after verifying the code.
- `POST /api/v1/auth/2fa/disable` `{ totp }` → requires a valid current code.
- When 2FA is enabled, `POST /auth/login` returns `401 {"error":"totp_required"}`
  until a valid `totp` is included in the body.

## Audit & observability
- `GET /api/v1/audit?limit=` *(admin)* — security audit trail.
- `GET /api/v1/audit/export.csv` *(admin)* — audit trail as CSV.
- `GET /api/v1/logs/export.csv?…` — current log filter as CSV (same query params as `/logs`).
- `GET /api/v1/logs/timeseries` — 24 hourly buckets `{ hour, total, errors }` for charts.
- `GET /metrics` — Prometheus exposition. If `METRICS_TOKEN` is set, requires
  `Authorization: Bearer <token>`.

## System / updates

- `GET /api/v1/system/update` → `{ current, latest, update_available, checked_at, error, update_command }`
  — cached result of the 6-hourly GitHub version check.
- `POST /api/v1/system/update/check` *(operator+)* → forces a re-check now.
- `POST /api/v1/system/update/apply` *(admin)* → one-click update. Writes a trigger
  file that a root systemd path-unit (`logwatch-panel-updater.path`) picks up to run
  `scripts/update.sh` — the sandboxed panel itself never gains privileges. Returns
  `409` with the manual `update_command` if the updater unit is not installed.

Note: `DELETE /api/v1/servers/:id` returns immediately; the server's log history is
purged in background chunks so large histories never block the panel.

## Intelligence (v1.6)
- `GET /api/v1/threats?hours=` — top external attacker IPs from auth/access logs.
- `GET /api/v1/ai/status` → `{ enabled, model }`.
- `POST /api/v1/ai/explain` `{ id | message }` — Claude root-cause + fix (requires `ANTHROPIC_API_KEY`; else 503).
- `POST /api/v1/ai/search` `{ query }` — natural language → `{ filter, params }` for `/logs`.
- Anomaly detection runs server-side and emits **new error pattern** / **error
  rate spike** system alerts (toggle with the `anomaly_enabled` setting).

## Health
### `GET /api/v1/health` → `{ "status": "ok", "version": "<panel version>", "time": <unix> }`

## Agent distribution (public, no auth)
- `GET /agent/install.sh` — the installer script.
- `GET /agent/download/logwatch-agent-linux-<amd64|arm64|armv7|386>` — agent binary.
- `GET /api/v1/agent/version` — version of the distributed agent binaries.
  Agents poll this hourly and **self-update**: they download the new binary,
  verify it (`--version`), atomically replace themselves and exit so systemd
  restarts the new version. Disable per server with `"auto_update": false` in
  `/etc/logwatch-agent/config.json`.
