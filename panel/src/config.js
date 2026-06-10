// Central configuration. All values come from environment variables so the
// installer can populate them via /etc/logwatch-panel/config.env (loaded by the
// systemd unit). Sensible defaults are provided for local development.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// Lightweight .env loader (no external dependency). Reads KEY=VALUE lines.
function loadEnvFile(path) {
  if (!path || !existsSync(path)) return;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // Under systemd the EnvironmentFile already injected these vars, so a direct
    // read failure (e.g. permissions) is non-fatal — warn and continue.
    console.warn(`[config] could not read ${path}: ${err.code || err.message} — relying on process environment.`);
    return;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(process.env.LOGWATCH_CONFIG || '/etc/logwatch-panel/config.env');

function int(name, def) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

// JWT secret: must be stable across restarts in production. If unset we generate
// an ephemeral one (sessions invalidate on restart) and warn.
let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  jwtSecret = randomBytes(48).toString('hex');
  // eslint-disable-next-line no-console
  console.warn('[config] JWT_SECRET not set — using an ephemeral secret. Sessions will not survive a restart.');
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: int('PORT', 8088),
  // Public base URL of the panel (used to build agent install one-liners).
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${int('PORT', 8088)}`).replace(/\/$/, ''),
  dbPath: process.env.DB_PATH || './data/logwatch.db',
  jwtSecret,
  jwtExpiry: process.env.JWT_EXPIRY || '12h',
  // Retention in days (logs older than this are pruned). 0 = keep forever.
  retentionDays: int('RETENTION_DAYS', 14),
  retentionSweepMinutes: int('RETENTION_SWEEP_MINUTES', 60),
  // A server is considered offline if no logs/heartbeat received within this many seconds.
  agentOfflineSeconds: int('AGENT_OFFLINE_SECONDS', 120),
  heartbeatCheckSeconds: int('HEARTBEAT_CHECK_SECONDS', 30),
  // Login rate limit
  loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 8),
  loginWindowMinutes: int('LOGIN_WINDOW_MINUTES', 5),
  // Max ingest batch size (entries per request)
  ingestMaxBatch: int('INGEST_MAX_BATCH', 1000),
  // Directory holding compiled agent binaries served to new servers.
  agentBinDir: process.env.AGENT_BIN_DIR || '../agent-bin',
  trustProxy: bool('TRUST_PROXY', false),
  isProd: process.env.NODE_ENV === 'production',
  // Optional bearer token protecting GET /metrics (Prometheus). Unset = open.
  metricsToken: process.env.METRICS_TOKEN || '',
  // Optional UDP syslog listener (RFC3164/5424). 0 = disabled. Maps incoming
  // by source IP to a server's ingest_ip. Use >1024 unless running as root.
  syslogUdpPort: int('SYSLOG_UDP_PORT', 0),
  // Optional AI assistant (Claude). Unset key = feature disabled.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-opus-4-8',
};

// Optional SSO via OpenID Connect (Authorization Code + PKCE). Enabled only when
// issuer + client id + secret are all set.
const oidcPublicUrl = config.publicUrl;
export const oidc = {
  enabled: !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET),
  issuer: (process.env.OIDC_ISSUER || '').replace(/\/$/, ''),
  clientId: process.env.OIDC_CLIENT_ID || '',
  clientSecret: process.env.OIDC_CLIENT_SECRET || '',
  redirectUri: process.env.OIDC_REDIRECT_URI || `${oidcPublicUrl}/api/v1/auth/oidc/callback`,
  scope: process.env.OIDC_SCOPE || 'openid email profile',
  defaultRole: ['admin', 'operator', 'viewer'].includes(process.env.OIDC_DEFAULT_ROLE)
    ? process.env.OIDC_DEFAULT_ROLE
    : 'viewer',
  // Optional comma-separated email-domain allowlist (e.g. "example.com,corp.io").
  allowedDomains: (process.env.OIDC_ALLOWED_DOMAINS || '')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  buttonLabel: process.env.OIDC_BUTTON_LABEL || 'Sign in with SSO',
};
