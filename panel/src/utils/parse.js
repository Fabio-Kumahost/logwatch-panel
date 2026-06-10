// Structured field extraction. Turns common log line shapes into key/value
// fields that can be searched and filtered. Returns {} when nothing matches.
// Conservative and dependency-free; runs on every ingested entry.

const NGINX_RE =
  /^(\S+) \S+ \S+ \[[^\]]+\] "(\S+) (\S+) [^"]*" (\d{3}) (\d+|-)(?: "[^"]*" "([^"]*)")?/;
const KV_RE = /(\w[\w.-]*)=("([^"]*)"|'([^']*)'|[^\s,;]+)/g;

function clampObj(obj, max = 25) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  const out = {};
  for (const k of keys.slice(0, max)) out[k] = obj[k];
  return out;
}

export function extractFields(message, source) {
  if (!message) return null;
  const msg = String(message);

  // 1) JSON log lines (structured loggers).
  const trimmed = msg.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const flat = {};
        for (const [k, v] of Object.entries(obj)) {
          if (v === null || typeof v === 'object') continue;
          flat[k] = String(v).slice(0, 256);
        }
        if (Object.keys(flat).length) return clampObj(flat);
      }
    } catch { /* not JSON */ }
  }

  // 2) Nginx/Apache combined access log.
  if (source === 'nginx' || source === 'apache' || /"\w+ \S+ HTTP/.test(msg)) {
    const m = NGINX_RE.exec(msg);
    if (m) {
      const f = { client_ip: m[1], method: m[2], path: m[3].slice(0, 256), status: m[4] };
      if (m[5] && m[5] !== '-') f.bytes = m[5];
      if (m[6]) f.user_agent = m[6].slice(0, 200);
      return f;
    }
  }

  // 3) key=value pairs (very common in app/syslog lines).
  const kv = {};
  let match;
  let count = 0;
  while ((match = KV_RE.exec(msg)) !== null && count < 25) {
    const key = match[1];
    const val = match[3] ?? match[4] ?? match[2];
    if (val !== undefined) { kv[key] = String(val).slice(0, 256); count++; }
  }
  if (Object.keys(kv).length) return kv;

  return null;
}
