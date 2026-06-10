// Threat sources: aggregates attacker IPs from auth/access logs (failed logins,
// invalid users, nginx access). Pure aggregation — no external GeoIP dependency.
import { db } from '../db/index.js';
import { requireUser } from '../auth/middleware.js';

const IP_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

// Skip private/reserved ranges — we only care about external sources.
function isPublic(ip) {
  const o = ip.split('.').map(Number);
  if (o.some((n) => n > 255)) return false;
  if (o[0] === 10) return false;
  if (o[0] === 127) return false;
  if (o[0] === 0) return false;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
  if (o[0] === 192 && o[1] === 168) return false;
  if (o[0] === 169 && o[1] === 254) return false;
  return true;
}

export default async function threatRoutes(app) {
  app.get('/api/v1/threats', { preHandler: requireUser }, async (request) => {
    const hours = Math.min(Math.max(parseInt(request.query.hours || '24', 10) || 24, 1), 168);
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    // Focus on security-relevant lines (auth failures, brute force, access logs).
    const rows = db.prepare(
      `SELECT message, fields FROM logs
       WHERE received_at >= ?
         AND (source IN ('auth','nginx','apache')
              OR message LIKE '%Failed password%'
              OR message LIKE '%Invalid user%'
              OR message LIKE '%authentication failure%')
       ORDER BY received_at DESC LIMIT 30000`
    ).all(since);

    const counts = new Map(); // ip -> { count, suspicious, sample }
    for (const r of rows) {
      const suspicious = /failed password|invalid user|authentication failure|brute/i.test(r.message);
      let m;
      IP_RE.lastIndex = 0;
      const seen = new Set();
      while ((m = IP_RE.exec(r.message)) !== null) {
        const ip = m[0];
        if (seen.has(ip) || !isPublic(ip)) continue;
        seen.add(ip);
        const e = counts.get(ip) || { ip, count: 0, suspicious: 0, sample: r.message.slice(0, 160) };
        e.count++;
        if (suspicious) e.suspicious++;
        counts.set(ip, e);
      }
    }
    const top = [...counts.values()]
      .sort((a, b) => b.suspicious - a.suspicious || b.count - a.count)
      .slice(0, 40);
    return { hours, total_sources: counts.size, top };
  });
}
