import { z } from 'zod';
import { db, getSetting, setSetting } from '../db/index.js';
import { hashPassword } from '../auth/auth.js';
import { requireUser, requireRole } from '../auth/middleware.js';

const userSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(256),
  role: z.enum(['admin', 'operator', 'viewer']).default('operator'),
});

export default async function adminRoutes(app) {
  // ---- Users (admin only) ----
  app.get('/api/v1/users', { preHandler: requireRole('admin') }, async () =>
    db.prepare('SELECT id, username, role, created_at, last_login FROM users ORDER BY username').all()
  );

  app.post('/api/v1/users', { preHandler: requireRole('admin') }, async (request, reply) => {
    const p = userSchema.safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid user (password >= 8 chars)' });
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(p.data.username);
    if (exists) return reply.code(409).send({ error: 'username taken' });
    const hash = await hashPassword(p.data.password);
    const info = db
      .prepare('INSERT INTO users(username, password_hash, role) VALUES(?,?,?)')
      .run(p.data.username, hash, p.data.role);
    return reply.code(201).send({ id: info.lastInsertRowid });
  });

  app.delete('/api/v1/users/:id', { preHandler: requireRole('admin') }, async (request, reply) => {
    if (Number(request.params.id) === request.user.id) {
      return reply.code(400).send({ error: 'cannot delete yourself' });
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (count <= 1) return reply.code(400).send({ error: 'cannot delete the last user' });
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(request.params.id);
    if (info.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ---- Settings ----
  app.get('/api/v1/settings', { preHandler: requireUser }, async () => ({
    retention_days: Number(getSetting('retention_days', null)),
    alert_channel_id: getSetting('alert_channel_id', null),
  }));

  const settingsSchema = z.object({
    retention_days: z.coerce.number().int().min(0).max(3650).optional(),
    alert_channel_id: z.coerce.number().int().nullable().optional(),
  });
  app.put('/api/v1/settings', { preHandler: requireRole('admin') }, async (request, reply) => {
    const p = settingsSchema.safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid settings' });
    if (p.data.retention_days !== undefined) setSetting('retention_days', p.data.retention_days);
    if (p.data.alert_channel_id !== undefined) setSetting('alert_channel_id', p.data.alert_channel_id ?? '');
    return { ok: true };
  });
}
