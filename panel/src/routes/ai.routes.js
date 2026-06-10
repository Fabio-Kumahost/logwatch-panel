import { z } from 'zod';
import { db } from '../db/index.js';
import { requireUser } from '../auth/middleware.js';
import { aiEnabled, explain, nlSearch } from '../services/ai.js';
import { config } from '../config.js';

export default async function aiRoutes(app) {
  app.get('/api/v1/ai/status', { preHandler: requireUser }, async () => ({
    enabled: aiEnabled(),
    model: aiEnabled() ? config.aiModel : null,
  }));

  // Explain a stored log entry (by id) or a raw message.
  const explainSchema = z.object({
    id: z.coerce.number().int().optional(),
    message: z.string().max(8000).optional(),
  });
  app.post('/api/v1/ai/explain', { preHandler: requireUser }, async (request, reply) => {
    if (!aiEnabled()) return reply.code(503).send({ error: 'AI not configured' });
    const p = explainSchema.safeParse(request.body);
    if (!p.success) return reply.code(400).send({ error: 'provide id or message' });
    let entry;
    if (p.data.id) {
      entry = db.prepare(
        `SELECT logs.message, logs.source, logs.service, logs.level, servers.name AS server_name
         FROM logs LEFT JOIN servers ON servers.id = logs.server_id WHERE logs.id = ?`
      ).get(p.data.id);
      if (!entry) return reply.code(404).send({ error: 'log not found' });
    } else if (p.data.message) {
      entry = { message: p.data.message };
    } else {
      return reply.code(400).send({ error: 'provide id or message' });
    }
    try {
      return { explanation: await explain(entry) };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // Natural-language search → returns a filter the UI can apply.
  app.post('/api/v1/ai/search', { preHandler: requireUser }, async (request, reply) => {
    if (!aiEnabled()) return reply.code(503).send({ error: 'AI not configured' });
    const query = (request.body && request.body.query) || '';
    if (!query || String(query).length > 500) return reply.code(400).send({ error: 'invalid query' });
    try {
      return await nlSearch(query);
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });
}
