import { z } from 'zod';
import { db } from '../db/index.js';
import { requireUser, requireRole } from '../auth/middleware.js';
import { reloadRules, invalidateRegex, dispatchSystemAlert } from '../services/alerts.js';
import { sendToChannel } from '../services/notifier.js';
import { LEVELS } from '../utils/normalize.js';

const channelSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['discord', 'gotify', 'smtp', 'telegram']),
  config: z.record(z.any()),
  enabled: z.boolean().optional(),
});

const ruleSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  match_type: z.enum(['keyword', 'regex', 'level']),
  pattern: z.string().max(512).optional().nullable(),
  min_level: z.enum(LEVELS).optional().nullable(),
  source: z.string().max(64).optional().nullable(),
  server_group: z.string().max(64).optional().nullable(),
  server_id: z.coerce.number().int().optional().nullable(),
  window_seconds: z.coerce.number().int().min(0).max(86400).default(0),
  threshold: z.coerce.number().int().min(1).max(10000).default(1),
  cooldown_seconds: z.coerce.number().int().min(0).max(86400).default(300),
  channel_id: z.coerce.number().int().optional().nullable(),
});

function redactChannel(c) {
  // Don't leak secrets to the UI; report only which keys are set.
  let cfg = {};
  try { cfg = JSON.parse(c.config); } catch { /* ignore */ }
  const keys = Object.keys(cfg);
  return { id: c.id, name: c.name, type: c.type, enabled: !!c.enabled, config_keys: keys, created_at: c.created_at };
}

export default async function alertRoutes(app) {
  // ---- Channels ----
  app.get('/api/v1/channels', { preHandler: requireUser }, async () =>
    db.prepare('SELECT * FROM channels ORDER BY name').all().map(redactChannel)
  );

  app.post('/api/v1/channels', { preHandler: requireRole('operator') }, async (request, reply) => {
    const p = channelSchema.safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid channel', detail: p.error.issues });
    const info = db
      .prepare('INSERT INTO channels(name, type, config, enabled) VALUES(?,?,?,?)')
      .run(p.data.name, p.data.type, JSON.stringify(p.data.config), p.data.enabled === false ? 0 : 1);
    reloadRules();
    return reply.code(201).send({ id: info.lastInsertRowid });
  });

  app.put('/api/v1/channels/:id', { preHandler: requireRole('operator') }, async (request, reply) => {
    const p = channelSchema.safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid channel' });
    const info = db
      .prepare('UPDATE channels SET name=?, type=?, config=?, enabled=? WHERE id=?')
      .run(p.data.name, p.data.type, JSON.stringify(p.data.config), p.data.enabled === false ? 0 : 1, request.params.id);
    if (info.changes === 0) return reply.code(404).send({ error: 'not found' });
    reloadRules();
    return { ok: true };
  });

  const deleteChannel = async (request, reply) => {
    const info = db.prepare('DELETE FROM channels WHERE id=?').run(request.params.id);
    if (info.changes === 0) return reply.code(404).send({ error: 'not found' });
    reloadRules();
    return { ok: true };
  };
  app.delete('/api/v1/channels/:id', { preHandler: requireRole('operator') }, deleteChannel);
  // POST alias — some firewalls drop DELETE requests entirely.
  app.post('/api/v1/channels/:id/delete', { preHandler: requireRole('operator') }, deleteChannel);

  // Send a test notification through a stored channel.
  app.post('/api/v1/channels/:id/test', { preHandler: requireRole('operator') }, async (request, reply) => {
    const c = db.prepare('SELECT * FROM channels WHERE id=?').get(request.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    try {
      await sendToChannel(c, {
        title: 'LogWatch test notification',
        level: 'info',
        message: 'This is a test message from your LogWatch Panel. If you can read this, the channel works.',
        server: 'panel',
        source: 'test',
        rule: 'manual test',
      });
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // ---- Rules ----
  app.get('/api/v1/rules', { preHandler: requireUser }, async () =>
    db.prepare('SELECT * FROM rules ORDER BY name').all()
  );

  app.post('/api/v1/rules', { preHandler: requireRole('operator') }, async (request, reply) => {
    const p = ruleSchema.safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid rule', detail: p.error.issues });
    const d = p.data;
    const info = db
      .prepare(
        `INSERT INTO rules(name,enabled,match_type,pattern,min_level,source,server_group,server_id,
           window_seconds,threshold,cooldown_seconds,channel_id)
         VALUES(@name,@enabled,@match_type,@pattern,@min_level,@source,@server_group,@server_id,
           @window_seconds,@threshold,@cooldown_seconds,@channel_id)`
      )
      .run({
        ...d,
        enabled: d.enabled === false ? 0 : 1,
        pattern: d.pattern || null,
        min_level: d.min_level || null,
        source: d.source || null,
        server_group: d.server_group || null,
        server_id: d.server_id || null,
        channel_id: d.channel_id || null,
      });
    reloadRules();
    return reply.code(201).send({ id: info.lastInsertRowid });
  });

  app.put('/api/v1/rules/:id', { preHandler: requireRole('operator') }, async (request, reply) => {
    const p = ruleSchema.safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid rule' });
    const d = p.data;
    const info = db
      .prepare(
        `UPDATE rules SET name=@name,enabled=@enabled,match_type=@match_type,pattern=@pattern,
           min_level=@min_level,source=@source,server_group=@server_group,server_id=@server_id,
           window_seconds=@window_seconds,threshold=@threshold,cooldown_seconds=@cooldown_seconds,
           channel_id=@channel_id WHERE id=@id`
      )
      .run({
        ...d,
        id: Number(request.params.id),
        enabled: d.enabled === false ? 0 : 1,
        pattern: d.pattern || null,
        min_level: d.min_level || null,
        source: d.source || null,
        server_group: d.server_group || null,
        server_id: d.server_id || null,
        channel_id: d.channel_id || null,
      });
    if (info.changes === 0) return reply.code(404).send({ error: 'not found' });
    invalidateRegex(Number(request.params.id));
    reloadRules();
    return { ok: true };
  });

  const deleteRule = async (request, reply) => {
    const info = db.prepare('DELETE FROM rules WHERE id=?').run(request.params.id);
    if (info.changes === 0) return reply.code(404).send({ error: 'not found' });
    reloadRules();
    return { ok: true };
  };
  app.delete('/api/v1/rules/:id', { preHandler: requireRole('operator') }, deleteRule);
  app.post('/api/v1/rules/:id/delete', { preHandler: requireRole('operator') }, deleteRule);

  // ---- Alert event history ----
  app.get('/api/v1/alerts/events', { preHandler: requireUser }, async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '100', 10) || 100, 500);
    return db
      .prepare(
        `SELECT e.*, r.name AS rule_name, s.name AS server_name
         FROM alert_events e
         LEFT JOIN rules r ON r.id = e.rule_id
         LEFT JOIN servers s ON s.id = e.server_id
         ORDER BY e.fired_at DESC LIMIT ?`
      )
      .all(limit);
  });
}
