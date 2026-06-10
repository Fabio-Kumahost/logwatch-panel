import { z } from 'zod';
import { db } from '../db/index.js';
import { requireUser } from '../auth/middleware.js';
import { LEVELS, LEVEL_RANK } from '../utils/normalize.js';

const querySchema = z.object({
  q: z.string().max(200).optional(),
  server_id: z.coerce.number().int().optional(),
  level: z.enum(LEVELS).optional(),        // minimum level
  source: z.string().max(64).optional(),
  service: z.string().max(128).optional(),
  from: z.coerce.number().int().optional(), // unix seconds
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['asc', 'desc']).default('desc'),
});

// Turn free text into a safe FTS5 MATCH expression (AND of quoted tokens).
function toFtsQuery(q) {
  const tokens = q.match(/[\p{L}\p{N}_./:-]+/gu) || [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

export default async function logRoutes(app) {
  app.get('/api/v1/logs', { preHandler: requireUser }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' });
    const f = parsed.data;

    const where = [];
    const params = [];
    let from = 'logs';

    if (f.q) {
      const match = toFtsQuery(f.q);
      if (match) {
        from = 'logs JOIN logs_fts ON logs.id = logs_fts.rowid';
        where.push('logs_fts MATCH ?');
        params.push(match);
      }
    }
    if (f.server_id) { where.push('logs.server_id = ?'); params.push(f.server_id); }
    if (f.source) { where.push('logs.source = ?'); params.push(f.source); }
    if (f.service) { where.push('logs.service = ?'); params.push(f.service); }
    if (f.from) { where.push('logs.ts >= ?'); params.push(f.from); }
    if (f.to) { where.push('logs.ts <= ?'); params.push(f.to); }
    if (f.level) {
      const allowed = LEVELS.filter((l) => LEVEL_RANK[l] >= LEVEL_RANK[f.level]);
      where.push(`logs.level IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const dir = f.sort === 'asc' ? 'ASC' : 'DESC'; // validated enum, not user SQL
    const rows = db
      .prepare(
        `SELECT logs.id, logs.server_id, logs.ts, logs.received_at, logs.source,
                logs.service, logs.level, logs.host, logs.message,
                servers.name AS server_name
         FROM ${from}
         LEFT JOIN servers ON servers.id = logs.server_id
         ${whereSql}
         ORDER BY logs.ts ${dir}, logs.id ${dir}
         LIMIT ? OFFSET ?`
      )
      .all(...params, f.limit, f.offset);

    return { logs: rows, limit: f.limit, offset: f.offset, sort: f.sort };
  });

  // CSV export of the current filter (capped for safety).
  app.get('/api/v1/logs/export.csv', { preHandler: requireUser }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' });
    const f = parsed.data;
    const where = [];
    const params = [];
    let fromClause = 'logs';
    if (f.q) {
      const match = toFtsQuery(f.q);
      if (match) { fromClause = 'logs JOIN logs_fts ON logs.id = logs_fts.rowid'; where.push('logs_fts MATCH ?'); params.push(match); }
    }
    if (f.server_id) { where.push('logs.server_id = ?'); params.push(f.server_id); }
    if (f.source) { where.push('logs.source = ?'); params.push(f.source); }
    if (f.service) { where.push('logs.service = ?'); params.push(f.service); }
    if (f.from) { where.push('logs.ts >= ?'); params.push(f.from); }
    if (f.to) { where.push('logs.ts <= ?'); params.push(f.to); }
    if (f.level) {
      const allowed = LEVELS.filter((l) => LEVEL_RANK[l] >= LEVEL_RANK[f.level]);
      where.push(`logs.level IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const dir = f.sort === 'asc' ? 'ASC' : 'DESC';
    const rows = db.prepare(
      `SELECT logs.ts, servers.name AS server, logs.source, logs.service, logs.level, logs.message
       FROM ${fromClause} LEFT JOIN servers ON servers.id = logs.server_id
       ${whereSql} ORDER BY logs.ts ${dir}, logs.id ${dir} LIMIT 50000`
    ).all(...params);
    const header = 'time,server,source,service,level,message\n';
    const csv = header + rows.map((r) =>
      [new Date(r.ts * 1000).toISOString(), r.server || '', r.source || '', r.service || '', r.level || '', r.message]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="logwatch-logs.csv"');
    return csv;
  });

  // Hourly log volume for the last 24h (dashboard chart). Optional level filter.
  app.get('/api/v1/logs/timeseries', { preHandler: requireUser }, async () => {
    const since = Math.floor(Date.now() / 1000) - 24 * 3600;
    const rows = db.prepare(
      `SELECT (received_at / 3600) AS bucket,
              SUM(CASE WHEN level IN ('error','critical') THEN 1 ELSE 0 END) AS errors,
              COUNT(*) AS total
       FROM logs WHERE received_at >= ? GROUP BY bucket ORDER BY bucket`
    ).all(since);
    const nowBucket = Math.floor(Date.now() / 1000 / 3600);
    const map = new Map(rows.map((r) => [r.bucket, r]));
    const series = [];
    for (let b = nowBucket - 23; b <= nowBucket; b++) {
      const r = map.get(b);
      series.push({ hour: b * 3600, total: r?.total || 0, errors: r?.errors || 0 });
    }
    return { series };
  });

  // Distinct values to populate filter dropdowns in the UI.
  app.get('/api/v1/logs/facets', { preHandler: requireUser }, async () => {
    const sources = db
      .prepare('SELECT DISTINCT source FROM logs WHERE source IS NOT NULL ORDER BY source LIMIT 200')
      .all()
      .map((r) => r.source);
    const services = db
      .prepare('SELECT DISTINCT service FROM logs WHERE service IS NOT NULL ORDER BY service LIMIT 500')
      .all()
      .map((r) => r.service);
    return { sources, services, levels: LEVELS };
  });

  // Aggregate counts for the dashboard (last 24h).
  app.get('/api/v1/logs/stats', { preHandler: requireUser }, async () => {
    const since = Math.floor(Date.now() / 1000) - 86400;
    const byLevel = db
      .prepare(
        `SELECT level, COUNT(*) AS n FROM logs WHERE received_at >= ? GROUP BY level`
      )
      .all(since);
    const total = db.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
    return { total, last24h: byLevel };
  });
}
