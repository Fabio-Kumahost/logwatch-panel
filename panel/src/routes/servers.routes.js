import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { generateAgentToken, hashToken } from '../auth/auth.js';
import { requireUser, requireRole } from '../auth/middleware.js';

function installCommand(token) {
  return `curl -sSL ${config.publicUrl}/agent/install.sh | sudo bash -s -- --panel ${config.publicUrl} --token ${token}`;
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  group_name: z.string().min(1).max(64).optional(),
});

export default async function serverRoutes(app) {
  // List all servers with derived live status.
  app.get('/api/v1/servers', { preHandler: requireUser }, async () => {
    const rows = db.prepare('SELECT * FROM servers ORDER BY name').all();
    const nowSec = Math.floor(Date.now() / 1000);
    return rows.map((s) => {
      const lastLog = db
        .prepare('SELECT MAX(received_at) AS t FROM logs WHERE server_id = ?')
        .get(s.id);
      const online = s.last_seen && nowSec - s.last_seen <= config.agentOfflineSeconds;
      return {
        id: s.id,
        name: s.name,
        group_name: s.group_name,
        hostname: s.hostname,
        os: s.os,
        os_version: s.os_version,
        agent_version: s.agent_version,
        status: s.status === 'pending' ? 'pending' : online ? 'online' : 'offline',
        last_seen: s.last_seen,
        last_log: lastLog?.t || null,
        created_at: s.created_at,
      };
    });
  });

  // Register a new server. Returns the plaintext token + install one-liner ONCE.
  app.post('/api/v1/servers', { preHandler: requireRole('operator') }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const token = generateAgentToken();
    const info = db
      .prepare('INSERT INTO servers(name, token_hash, group_name) VALUES(?,?,?)')
      .run(parsed.data.name, hashToken(token), parsed.data.group_name || 'default');
    return reply.code(201).send({
      id: info.lastInsertRowid,
      name: parsed.data.name,
      token, // shown once
      install_command: installCommand(token),
    });
  });

  app.get('/api/v1/servers/:id', { preHandler: requireUser }, async (request, reply) => {
    const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(request.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN level IN ('error','critical') THEN 1 ELSE 0 END) AS errors
         FROM logs WHERE server_id = ?`
      )
      .get(s.id);
    const sources = db
      .prepare('SELECT DISTINCT source FROM logs WHERE server_id = ? AND source IS NOT NULL')
      .all(s.id)
      .map((r) => r.source);
    return { ...s, token_hash: undefined, stats, sources };
  });

  // Rotate the agent token (invalidates the old one).
  app.post('/api/v1/servers/:id/rotate', { preHandler: requireRole('operator') }, async (request, reply) => {
    const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(request.params.id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    const token = generateAgentToken();
    db.prepare('UPDATE servers SET token_hash = ? WHERE id = ?').run(hashToken(token), s.id);
    return { token, install_command: installCommand(token) };
  });

  app.delete('/api/v1/servers/:id', { preHandler: requireRole('operator') }, async (request, reply) => {
    const id = Number(request.params.id);
    const s = db.prepare('SELECT id FROM servers WHERE id = ?').get(id);
    if (!s) return reply.code(404).send({ error: 'not found' });

    // A server can own hundreds of thousands of log rows. Letting the FK
    // CASCADE delete them synchronously blocks the event loop for minutes and
    // the whole panel appears offline ("failed to fetch"). Instead: remove the
    // server row immediately (FKs briefly off so the cascade doesn't fire) and
    // purge its logs in background chunks that yield between batches.
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM alert_events WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM rules WHERE server_id = ?').run(id);

    purgeServerLogs(id, request.log);
    return { ok: true };
  });
}

// Deletes a removed server's logs in chunks without blocking the event loop.
async function purgeServerLogs(serverId, log) {
  const chunk = db.prepare(
    'DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE server_id = ? LIMIT 5000)'
  );
  let total = 0;
  try {
    for (;;) {
      const { changes } = chunk.run(serverId);
      total += changes;
      if (changes === 0) break;
      await new Promise((resolve) => setImmediate(resolve)); // yield to other requests
    }
    if (total > 0) log?.info(`[servers] purged ${total} log rows of deleted server #${serverId}`);
  } catch (err) {
    log?.error(`[servers] background log purge failed for #${serverId}: ${err.message}`);
  }
}
