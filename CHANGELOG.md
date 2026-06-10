# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.7.0] — 2026-06-10 — "SSO"
### Added
- **Single Sign-On via OpenID Connect** (Authorization Code + PKCE): works with
  Authentik, Keycloak, Google, Azure AD, Auth0, etc. State/CSRF protection,
  optional email-domain allowlist, auto-provisioning (default role `viewer`),
  SSO users cannot password-login. "Sign in with SSO" button on the login page.
  Configure with `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`.

## [1.6.0] — 2026-06-10 — "Intelligence"
### Added
- **Log pattern clustering**: lines are fingerprinted on ingest (variables →
  tokens) and grouped into templates — `GET /api/v1/logs/patterns`, new Insights
  view. Click a pattern to see its logs (`fp` filter).
- **Anomaly detection**: statistical error-rate spike detection + **new-error
  pattern** alerts (never-before-seen error fingerprints), with warmup so the
  backlog doesn't alert.
- **AI assistant (optional, Claude via official @anthropic-ai/sdk)**: "Explain
  with AI" on any log entry and natural-language search ("✨ Ask"). Enabled by
  setting `ANTHROPIC_API_KEY`; model configurable via `AI_MODEL` (default
  `claude-opus-4-8`).
- **Threat sources**: aggregates external attacker IPs from auth/access logs
  (`GET /api/v1/threats`) in the Insights view; private IPs excluded.
### Deferred
- SSO/OIDC moved to v1.7 (security-critical, needs dedicated provider testing).

## [1.5.0] — 2026-06-10 — "Platform"
### Added
- **Structured field extraction** on ingest (JSON, key=value, nginx/apache access
  logs) → searchable fields; clickable field chips and `field`/`fieldval` filter.
- **Foreign-source ingest**: `POST /api/v1/ingest/raw` (text/ndjson/json) for
  Vector, Fluent Bit, rsyslog (omhttp), OTel collectors; optional **UDP syslog
  listener** (`SYSLOG_UDP_PORT`, source-IP mapped via server `ingest_ip`).
- **Host metrics** from the agent (CPU/RAM/disk/load) with server-detail charts
  and built-in disk/memory threshold alerts.
- **Alerting**: Slack, Microsoft Teams, PagerDuty and Opsgenie channels; rule
  **quiet hours**; alert **acknowledgement** (on-call workflow).
- Agent **1.2.0**: host-metrics collector (self-updates from older agents).

## [1.4.0] — 2026-06-10
### Added
- **Two-factor authentication (TOTP / RFC 6238)** — optional per user, set up
  from Settings, enforced at login. Pure Node implementation, no dependencies.
- **Security audit log** — records logins (success/failure), server/user/settings
  changes and 2FA events with source IP; admin view + CSV export.
- **Dashboard charts** — 24h log-volume timeline and per-level breakdown (inline
  SVG, no chart library).
- **CSV log export** of the current filter; `/api/v1/logs/timeseries` endpoint.
- **Prometheus `/metrics`** endpoint (optionally protected by `METRICS_TOKEN`).
- **Docker** support: `Dockerfile`, `docker-compose.yml`, entrypoint with admin seeding.

## [1.3.1] — 2026-06-10
### Fixed
- UI resilience against flaky connection establishment: API client auto-retries
  network failures; 20s keep-alive reuses established connections.

## [1.3.0] — 2026-06-10
### Added
- Log sorting (`sort=asc|desc`); clickable log rows with a built-in fix-suggestion
  knowledge base (SSH brute force, disk full, OOM, TLS, DNS, …).
- Agent first-run **backfill** of recent history; agent **hourly self-update**
  against `/api/v1/agent/version`.

## [1.2.0] — 2026-06-10
### Added
- **One-click panel update** from the UI via a root systemd path-unit.
### Fixed
- All delete actions use `POST /:id/delete` aliases (some firewalls drop DELETE);
  cache-busted, version-tagged frontend assets.

## [1.1.x] — 2026-06-10
### Added
- GitHub update checker with dashboard banner + settings card.
### Fixed
- Non-blocking server deletion and retention (chunked background purge).
- 400 on body-less browser requests; config-file ownership (panel & agent);
  nginx `default_server`; `update.sh` git safe.directory.

## [1.0.0] — 2026-06-10
- Initial release: Fastify + SQLite(FTS5) panel, Go agent, installers, alerting
  (Discord/Gotify/Telegram/SMTP), live stream, RBAC, retention.
