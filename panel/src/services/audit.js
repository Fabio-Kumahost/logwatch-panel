// Security audit trail. Records who did what, with the source IP.
import { db } from '../db/index.js';

const insert = db.prepare(
  'INSERT INTO audit_log(user_id, username, action, target, detail, ip) VALUES(?,?,?,?,?,?)'
);

// record(request, action, target?, detail?) — request may be null for system events.
export function record(request, action, target = null, detail = null) {
  try {
    const user = request?.user || {};
    const ip = request?.ip || null;
    insert.run(user.id ?? null, user.username ?? null, action, target, detail, ip);
  } catch {
    // auditing must never break the request it describes
  }
}

export function recordRaw({ userId = null, username = null, action, target = null, detail = null, ip = null }) {
  try {
    insert.run(userId, username, action, target, detail, ip);
  } catch { /* ignore */ }
}

export function list(limit = 200) {
  return db
    .prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 1000));
}
