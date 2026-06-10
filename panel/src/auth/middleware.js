// Authentication helpers for routes.
import { db } from '../db/index.js';
import { hashToken } from './auth.js';

// Verifies the panel-user JWT. Attaches request.user = { id, username, role }.
export async function requireUser(request, reply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

// Role gate factory. requireRole('admin') etc. Viewer < operator < admin.
const RANK = { viewer: 1, operator: 2, admin: 3 };
export function requireRole(minRole) {
  return async function (request, reply) {
    await requireUser(request, reply);
    if (reply.sent) return;
    const have = RANK[request.user?.role] ?? 0;
    if (have < (RANK[minRole] ?? 99)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}

// Authenticates an agent by its bearer token. Resolves the server row and
// attaches request.server. Tokens are matched by SHA-256 hash.
export async function requireAgent(request, reply) {
  const header = request.headers.authorization || '';
  const m = header.match(/^Bearer\s+([A-Fa-f0-9]{16,128})$/);
  if (!m) return reply.code(401).send({ error: 'missing or malformed agent token' });
  const tokenHash = hashToken(m[1]);
  const server = db.prepare('SELECT * FROM servers WHERE token_hash = ?').get(tokenHash);
  if (!server) return reply.code(401).send({ error: 'invalid agent token' });
  // NB: request.server is reserved by Fastify (the instance), so use a custom key.
  request.agentServer = server;
}
