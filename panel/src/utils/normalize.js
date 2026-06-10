// Log level normalization and lightweight secret masking shared by ingest.
export const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];
export const LEVEL_RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));

// Maps various source-specific level spellings (syslog severities, journald
// PRIORITY, common words) onto our canonical set.
const LEVEL_ALIASES = {
  '0': 'critical', '1': 'critical', '2': 'critical', '3': 'error',
  '4': 'warning', '5': 'notice', '6': 'info', '7': 'debug',
  emerg: 'critical', emergency: 'critical', alert: 'critical', crit: 'critical',
  fatal: 'critical', panic: 'critical',
  err: 'error', error: 'error', failed: 'error', failure: 'error',
  warn: 'warning', warning: 'warning',
  notice: 'notice',
  info: 'info', information: 'info',
  debug: 'debug', trace: 'debug', verbose: 'debug',
};

export function normalizeLevel(raw, message = '') {
  if (raw) {
    const key = String(raw).trim().toLowerCase();
    if (LEVEL_ALIASES[key]) return LEVEL_ALIASES[key];
    if (LEVEL_RANK[key] !== undefined) return key;
  }
  // Heuristic fallback from the message text.
  const m = message.toLowerCase();
  if (/\b(critical|fatal|panic|emerg|segfault|out of memory|oom-kill)\b/.test(m)) return 'critical';
  if (/\b(error|err|failed|failure|denied|refused|exception|traceback)\b/.test(m)) return 'error';
  if (/\b(warn|warning|deprecated)\b/.test(m)) return 'warning';
  return 'info';
}

// Best-effort masking of obvious secrets before storage/display so credentials
// don't leak through logs. Conservative to avoid mangling real content.
const SECRET_PATTERNS = [
  [/(password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, '$1=***'],
  [/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***'],
  [/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1***'],
];

export function maskSecrets(text) {
  if (!text) return text;
  let out = String(text);
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}
