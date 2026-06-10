import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { requireAgent } from '../auth/middleware.js';
import { normalizeLevel, maskSecrets } from '../utils/normalize.js';
import { hub } from '../ws/hub.js';
import { evaluate } from '../services/alerts.js';

const entrySchema = z.object({
  ts: z.coerce.number().int().optional(),
  source: z.string().max(64).optional(),
  service: z.string().max(256).optional(),
  level: z.string().max(32).optional(),
  host: z.string().max(256).optional(),
  message: z.string().min(1).max(64 * 1024),
});

const batchSchema = z.object({
  host: z.string().max(256).optional(),
  os: z.string().max(64).optional(),
  os_version: z.string().max(128).optional(),
  agent_version: z.string().max(64).optional(),
  entries: z.array(entrySchema).max(5000),
});

export default async function ingestRoutes(app) {
  const insert = db.prepare(
    `INSERT INTO logs(server_id, ts, source, service, level, host, message)
     VALUES(@server_id, @ts, @source, @service, @level, @host, @message)`
  );

  app.post('/api/v1/ingest', { preHandler: requireAgent }, async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });
    const body = parsed.data;
    const server = request.agentServer;
    const nowSec = Math.floor(Date.now() / 1000);

    if (body.entries.length > config.ingestMaxBatch) {
      return reply.code(413).send({ error: `batch too large (max ${config.ingestMaxBatch})` });
    }

    // Update server metadata + mark online.
    db.prepare(
      `UPDATE servers SET status='online', last_seen=?, hostname=COALESCE(?,hostname),
         os=COALESCE(?,os), os_version=COALESCE(?,os_version), agent_version=COALESCE(?,agent_version)
       WHERE id=?`
    ).run(nowSec, body.host || null, body.os || null, body.os_version || null, body.agent_version || null, server.id);

    const prepared = body.entries.map((e) => {
      const message = maskSecrets(e.message);
      return {
        server_id: server.id,
        ts: e.ts && e.ts > 0 ? e.ts : nowSec,
        source: e.source || 'unknown',
        service: e.service || null,
        level: normalizeLevel(e.level, message),
        host: e.host || body.host || server.hostname || null,
        message,
      };
    });

    const tx = db.transaction((items) => {
      for (const it of items) {
        const info = insert.run(it);
        it.id = info.lastInsertRowid;
      }
    });
    tx(prepared);

    // Fan out to live stream subscribers and the alert engine.
    for (const it of prepared) {
      hub.publish({ ...it, server_name: server.name });
    }
    // Alert evaluation is async but we don't block the agent on delivery.
    evaluate(prepared, server).catch((err) => request.log.error(err));

    return reply.code(202).send({ accepted: prepared.length });
  });

  // Lightweight heartbeat for when there are no new logs to send.
  app.post('/api/v1/heartbeat', { preHandler: requireAgent }, async (request) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const b = request.body || {};
    db.prepare(
      `UPDATE servers SET status='online', last_seen=?, hostname=COALESCE(?,hostname),
         os=COALESCE(?,os), os_version=COALESCE(?,os_version), agent_version=COALESCE(?,agent_version)
       WHERE id=?`
    ).run(nowSec, b.host || null, b.os || null, b.os_version || null, b.agent_version || null, request.agentServer.id);
    return { ok: true, server_time: nowSec };
  });
}
