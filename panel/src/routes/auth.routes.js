import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { verifyPassword, hashPassword } from '../auth/auth.js';
import { requireUser } from '../auth/middleware.js';
import { record } from '../services/audit.js';
import { generateSecret, verifyTOTP, otpauthURI } from '../auth/totp.js';
import { isEnabled as oidcEnabled, buildAuthUrl, handleCallback, provisionUser, oidcConfig } from '../services/oidc.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  totp: z.string().max(10).optional(),
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
        record({ ip: request.ip }, 'login.failed', username, 'invalid credentials');
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      // Two-factor: if enabled the password alone is not enough.
      if (user.totp_enabled) {
        if (!parsed.data.totp) {
          return reply.code(401).send({ error: 'totp_required' });
        }
        if (!verifyTOTP(user.totp_secret, parsed.data.totp)) {
          record({ user: { id: user.id, username } , ip: request.ip }, 'login.failed', username, 'invalid 2FA code');
          return reply.code(401).send({ error: 'invalid 2FA code' });
        }
      }
      db.prepare('UPDATE users SET last_login = strftime(\'%s\',\'now\') WHERE id = ?').run(user.id);
      record({ user: { id: user.id, username }, ip: request.ip }, 'login.success', username);
      const token = await reply.jwtSign(
        { id: user.id, username: user.username, role: user.role },
        { expiresIn: config.jwtExpiry }
      );
      return { token, user: { id: user.id, username: user.username, role: user.role } };
    }
  );

  app.get('/api/v1/auth/me', { preHandler: requireUser }, async (request) => {
    const u = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(request.user.id);
    return { user: { ...request.user, totp_enabled: !!u?.totp_enabled } };
  });

  // ---- Two-factor (TOTP) ----
  // Step 1: generate a secret (not yet active) and return the otpauth URI.
  app.post('/api/v1/auth/2fa/setup', { preHandler: requireUser }, async (request) => {
    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, request.user.id);
    return { secret, otpauth_uri: otpauthURI(secret, request.user.username) };
  });

  // Step 2: confirm a code to activate 2FA.
  const codeSchema = z.object({ totp: z.string().regex(/^\d{6}$/) });
  app.post('/api/v1/auth/2fa/enable', { preHandler: requireUser }, async (request, reply) => {
    const p = codeSchema.safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: 'enter the 6-digit code' });
    const u = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(request.user.id);
    if (!u?.totp_secret) return reply.code(400).send({ error: 'run setup first' });
    if (!verifyTOTP(u.totp_secret, p.data.totp)) return reply.code(401).send({ error: 'code did not match — check your authenticator clock' });
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(request.user.id);
    record(request, '2fa.enabled', request.user.username);
    return { ok: true };
  });

  // Disable 2FA (requires a current valid code to prevent lockout abuse).
  app.post('/api/v1/auth/2fa/disable', { preHandler: requireUser }, async (request, reply) => {
    const p = codeSchema.safeParse(request.body);
    const u = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(request.user.id);
    if (!u?.totp_enabled) return { ok: true };
    if (!p.success || !verifyTOTP(u.totp_secret, p.data.totp)) {
      return reply.code(401).send({ error: 'enter a valid current 2FA code to disable' });
    }
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(request.user.id);
    record(request, '2fa.disabled', request.user.username);
    return { ok: true };
  });

  // ---- SSO (OpenID Connect) ----
  app.get('/api/v1/auth/oidc/config', async () => ({
    enabled: oidcEnabled(),
    button_label: oidcEnabled() ? oidcConfig.buttonLabel : null,
  }));

  // Begin the login flow — redirect the browser to the identity provider.
  app.get('/api/v1/auth/oidc/start', async (request, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'SSO not enabled' });
    try {
      const url = await buildAuthUrl();
      return reply.redirect(url);
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: `SSO start failed: ${err.message}` });
    }
  });

  // Provider redirects back here with ?code&state. Exchange, provision, issue JWT.
  app.get('/api/v1/auth/oidc/callback', async (request, reply) => {
    if (!oidcEnabled()) return reply.code(404).send({ error: 'SSO not enabled' });
    const { code, state, error } = request.query;
    const fail = (msg) => reply.redirect(`${config.publicUrl}/#sso_error=${encodeURIComponent(msg)}`);
    if (error) return fail(String(error));
    if (!code || !state) return fail('missing code/state');
    try {
      const claims = await handleCallback(String(code), String(state));
      const user = provisionUser(claims);
      const token = await reply.jwtSign(
        { id: user.id, username: user.username, role: user.role },
        { expiresIn: config.jwtExpiry }
      );
      record({ user: { id: user.id, username: user.username }, ip: request.ip }, 'login.sso', user.username);
      return reply.redirect(`${config.publicUrl}/#sso=${token}`);
    } catch (err) {
      request.log.warn({ err: err.message, ip: request.ip }, 'SSO callback failed');
      record({ ip: request.ip }, 'login.failed', 'sso', err.message);
      return fail(err.message);
    }
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
    record(request, 'password.changed', request.user.username);
    return { ok: true };
  });
}
