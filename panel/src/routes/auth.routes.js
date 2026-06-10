import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { verifyPassword, hashPassword } from '../auth/auth.js';
import { requireUser } from '../auth/middleware.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export default async function authRoutes(app) {
  // Login is rate-limited to blunt brute force (see config).
  app.post(
    '/api/v1/auth/login',
    {
      config: {
        rateLimit: {
          max: config.loginMaxAttempts,
          timeWindow: config.loginWindowMinutes * 60 * 1000,
        },
      },
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
      const { username, password } = parsed.data;

      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      const ok = user && (await verifyPassword(password, user.password_hash));
      if (!ok) {
        request.log.warn({ username, ip: request.ip }, 'failed login');
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      db.prepare('UPDATE users SET last_login = strftime(\'%s\',\'now\') WHERE id = ?').run(user.id);
      const token = await reply.jwtSign(
        { id: user.id, username: user.username, role: user.role },
        { expiresIn: config.jwtExpiry }
      );
      return { token, user: { id: user.id, username: user.username, role: user.role } };
    }
  );

  app.get('/api/v1/auth/me', { preHandler: requireUser }, async (request) => {
    return { user: request.user };
  });

  const pwSchema = z.object({
    current_password: z.string().min(1),
    new_password: z.string().min(8).max(256),
  });
  app.post('/api/v1/auth/password', { preHandler: requireUser }, async (request, reply) => {
    const parsed = pwSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'new password must be at least 8 chars' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id);
    if (!(await verifyPassword(parsed.data.current_password, user.password_hash))) {
      return reply.code(401).send({ error: 'current password incorrect' });
    }
    const hash = await hashPassword(parsed.data.new_password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    return { ok: true };
  });
}
