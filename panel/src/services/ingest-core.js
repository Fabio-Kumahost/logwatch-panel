// Shared log-ingestion pipeline used by the agent API, the raw HTTP endpoint
// and the syslog listener: normalize, mask secrets, extract fields, store,
// fan out to the live stream and evaluate alert rules.
import { db } from '../db/index.js';
import { normalizeLevel, maskSecrets } from '../utils/normalize.js';
import { extractFields } from '../utils/parse.js';
import { fingerprint } from '../utils/fingerprint.js';
import { hub } from '../ws/hub.js';
import { evaluate } from './alerts.js';

const insert = db.prepare(
  `INSERT INTO logs(server_id, ts, source, service, level, host, message, fields, fp)
   VALUES(@server_id, @ts, @source, @service, @level, @host, @message, @fields, @fp)`
);

// entries: [{ ts?, source?, service?, level?, host?, message }]
export function storeEntries(server, entries, logger) {
  if (!entries.length) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const prepared = entries.map((e) => {
    const message = maskSecrets(String(e.message));
    const source = e.source || 'unknown';
    const fields = extractFields(message, source);
    return {
      server_id: server.id,
      ts: e.ts && e.ts > 0 ? e.ts : nowSec,
      source,
      service: e.service || null,
      level: normalizeLevel(e.level, message),
      host: e.host || server.hostname || null,
      message,
      fields: fields ? JSON.stringify(fields) : null,
      fp: fingerprint(message),
    };
  });

  const tx = db.transaction((items) => {
    for (const it of items) {
      const info = insert.run(it);
      it.id = info.lastInsertRowid;
    }
  });
  tx(prepared);

  for (const it of prepared) hub.publish({ ...it, server_name: server.name });
  evaluate(prepared, server).catch((err) => logger?.error?.(err));
  return prepared.length;
}

export function touchServer(server, meta = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE servers SET status='online', last_seen=?, hostname=COALESCE(?,hostname),
       os=COALESCE(?,os), os_version=COALESCE(?,os_version), agent_version=COALESCE(?,agent_version)
     WHERE id=?`
  ).run(nowSec, meta.host || null, meta.os || null, meta.os_version || null, meta.agent_version || null, server.id);
}
