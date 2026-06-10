# Security Concept

LogWatch handles sensitive operational data (logs across a fleet), so it is
built secure-by-default. This document describes the threat model and controls.

## Threat model

| Asset | Threat | Control |
|-------|--------|---------|
| Panel admin accounts | Credential theft, brute force | bcrypt (cost 12) hashing, login rate limiting, JWT sessions |
| Agent → panel channel | Token theft, log injection, MITM | Per-server tokens (hashed at rest), HTTPS, input validation |
| Stored logs | Secret leakage | Secret masking on ingest, optional retention pruning |
| Host running the agent | Privilege abuse | Least-privilege user + hardened systemd unit |
| Panel host | RCE via input | Parameterized SQL, strict schema validation (zod), no shell exec on user input |

## Authentication & sessions

- **Panel users**: passwords hashed with **bcrypt** (cost 12). Login is rate-limited
  (`LOGIN_MAX_ATTEMPTS` per `LOGIN_WINDOW_MINUTES`, default 8/5min per IP) to blunt
  brute force. Sessions are stateless **JWTs** signed with a 48-byte random secret
  (`JWT_SECRET`), expiring after `JWT_EXPIRY` (default 12h).
- **Agents**: authenticate with a 32-byte random token. Only its **SHA-256 hash**
  is stored; tokens are compared in constant time. The plaintext token is shown
  once and can be rotated, instantly invalidating the old one.
- **RBAC**: roles `admin` > `operator` > `viewer`, enforced per route. Viewers read,
  operators manage servers/rules/channels, admins manage users and settings.

## Transport

- Designed to run behind **Nginx + Let's Encrypt** (the installer can provision
  both). The panel itself binds to `127.0.0.1` and is only exposed via the proxy.
- The agent uses HTTPS by default. `insecure_tls` exists for self-signed panels
  and is **opt-in** (off by default).

## Input handling (no injection)

- All SQL uses **parameterized prepared statements** (better-sqlite3). No string
  concatenation of user input into queries.
- Full-text search input is tokenized and quoted before being passed to FTS5.
- Request bodies and query params are validated with **zod** schemas; oversized
  batches and fields are rejected (`413` / `400`).
- The installer scripts quote variables, validate downloaded binary names against
  an allowlist regex (no path traversal), and never `eval` remote content.

## Secret handling

- Messages are scanned on ingest and obvious secrets (`password=`, `token=`,
  `Bearer …`, secrets in URLs) are **masked** before storage and display.
- Channel secrets (webhook URLs, bot tokens, SMTP passwords) are stored in the DB
  but **never returned** by the API — the UI only learns which keys are set.
- `JWT_SECRET` and the DB live in `/etc/logwatch-panel/config.env` (chmod 600) and
  `panel/data/` (owned by the service user).
- The panel logger **redacts** `Authorization` and `Cookie` headers.

## Agent privilege

- By default the agent runs as a dedicated unprivileged **`logwatch`** user added
  only to `adm`, `systemd-journal` and (if present) `docker` groups — enough to
  read most logs, nothing more.
- The systemd unit is hardened: `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp`, `ReadOnlyPaths=/var/log`, `RestrictSUIDSGID`,
  `MemoryMax=128M`, `CPUQuota=20%`.
- For full coverage of root-only logs (e.g. `/var/log/secure` on RHEL) the operator
  may explicitly opt in with `--run-as-root`. This is a documented, conscious choice.
- Missing or unreadable log files are skipped silently — the agent never crashes on
  absent sources.

## Reporting

Found a vulnerability? Please open a private security advisory on the GitHub
repository rather than a public issue.
