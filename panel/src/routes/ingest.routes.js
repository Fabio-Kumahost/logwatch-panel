import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { requireAgent } from '../auth/middleware.js';
import { dispatchSystemAlert } from '../services/alerts.js';
import { storeEntries, touchServer } from '../services/ingest-core.js';

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
  app.post('/api/v1/ingest', { preHandler: requireAgent }, async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid payload' });
    const body = parsed.data;
    const server = request.agentServer;
    if (body.entries.length > config.ingestMaxBatch) {
      return reply.code(413).send({ error: `batch too large (max ${config.ingestMaxBatch})` });
    }
    touchServer(server, body);
    const accepted = storeEntries(server, body.entries, request.log);
    return reply.code(202).send({ accepted });
  });

  // Raw ingest for foreign sources (Vector, Fluent Bit, rsyslog omhttp, OTel
  // collectors). Authenticated with the per-server token. Accepts:
  //   - text/plain         : one log line per row
  //   - application/x-ndjson: one JSON object {message,level?,source?,...} per row
  //   - application/json    : a single object or an array of such objects
  // Optional defaults via query: ?source=…&service=…
  app.post('/api/v1/ingest/raw', { preHandler: requireAgent }, async (request, reply) => {
    const server = request.agentServer;
    const qSource = typeof request.query.source === 'string' ? request.query.source : 'external';
    const qService = typeof request.query.service === 'string' ? request.query.service : undefined;
    const ct = (request.headers['content-type'] || '').toLowerCase();
    let entries = [];

    const fromObj = (o) => ({
      message: typeof o.message === 'string' ? o.message : JSON.stringify(o),
      level: o.level, source: o.source || qSource, service: o.service || qService,
      host: o.host, ts: o.ts,
    });

    if (ct.includes('application/json')) {
      const b = request.body;
      const arr = Array.isArray(b) ? b : [b];
      entries = arr.filter((o) => o && typeof o === 'object').map(fromObj);
    } else {
      // text/plain or ndjson arrive as a string (parser registered in server.js)
      const text = typeof request.body === 'string' ? request.body : '';
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (ct.includes('ndjson') || (t.startsWith('{') && t.endsWith('}'))) {
          try { entries.push(fromObj(JSON.parse(t))); continue; } catch { /* fall through */ }
        }
        entries.push({ message: t, source: qSource, service: qService });
      }
    }
    if (entries.length === 0) return reply.code(400).send({ error: 'no log lines found' });
    if (entries.length > config.ingestMaxBatch) entries = entries.slice(0, config.ingestMaxBatch);
    touchServer(server);
    const accepted = storeEntries(server, entries, request.log);
    return reply.code(202).send({ accepted });
  });

  // Host resource metrics from the agent (CPU/RAM/disk/load).
  const metricSchema = z.object({
    cpu: z.number().min(0).max(100).optional(),
    mem: z.number().min(0).max(100).optional(),
    disk: z.number().min(0).max(100).optional(),
    load1: z.number().min(0).optional(),
    uptime: z.coerce.number().int().optional(),
  });
  const insertMetric = db.prepare(
    'INSERT INTO host_metrics(server_id, cpu, mem, disk, load1, uptime) VALUES(?,?,?,?,?,?)'
  );
  // Per-server cooldown for resource threshold alerts.
  const metricAlertAt = new Map();
  app.post('/api/v1/metrics', { preHandler: requireAgent }, async (request, reply) => {
    const p = metricSchema.safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid metrics' });
    const m = p.data;
    const server = request.agentServer;
    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE servers SET status='online', last_seen=? WHERE id=?").run(nowSec, server.id);
    insertMetric.run(server.id, m.cpu ?? null, m.mem ?? null, m.disk ?? null, m.load1 ?? null, m.uptime ?? null);

    // Built-in threshold alerts (disk/mem) with a 30-min per-server cooldown.
    const checks = [
      ['disk', m.disk, 90, 'Disk almost full'],
      ['mem', m.mem, 95, 'Memory almost exhausted'],
    ];
    for (const [key, val, limit, title] of checks) {
      if (val != null && val >= limit) {
        const last = metricAlertAt.get(`${server.id}:${key}`) || 0;
        if (nowSec - last >= 1800) {
          metricAlertAt.set(`${server.id}:${key}`, nowSec);
          dispatchSystemAlert({
            title, level: 'critical', serverId: server.id, server: server.name,
            message: `${title} on "${server.name}": ${key}=${val.toFixed(1)}% (threshold ${limit}%).`,
          }).catch(() => {});
        }
      }
    }
    return reply.code(202).send({ ok: true });
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
