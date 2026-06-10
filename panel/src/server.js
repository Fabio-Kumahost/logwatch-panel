// LogWatch Panel — HTTP/WebSocket server entrypoint.
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import './db/index.js'; // applies schema on import
import { reloadRules, seedDefaultRules } from './services/alerts.js';
import { startRetention } from './services/retention.js';
import { startHeartbeat } from './services/heartbeat.js';
import { startUpdater, CURRENT_VERSION } from './services/updater.js';
import { startSyslog } from './services/syslog.js';
import { startAnomaly } from './services/anomaly.js';

import authRoutes from './routes/auth.routes.js';
import serverRoutes from './routes/servers.routes.js';
import logRoutes from './routes/logs.routes.js';
import ingestRoutes from './routes/ingest.routes.js';
import alertRoutes from './routes/alerts.routes.js';
import adminRoutes from './routes/admin.routes.js';
import agentInstallRoutes from './routes/agent-install.routes.js';
import streamRoutes from './routes/stream.routes.js';
import systemRoutes from './routes/system.routes.js';
import auditRoutes from './routes/audit.routes.js';
import metricsRoutes from './routes/metrics.routes.js';
import aiRoutes from './routes/ai.routes.js';
import threatRoutes from './routes/threats.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '../public');

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      transport: config.isProd ? undefined : { target: 'pino-pretty' },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024 * 1024, // 16MB to accommodate large log batches
  });

  // Tolerate an empty body sent with a JSON content-type (browsers/clients often
  // do this on POST/DELETE without payload) instead of Fastify's default 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || body === undefined) return done(null, undefined);
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Raw body parsers for the foreign-source ingest endpoint (Vector, Fluent
  // Bit, rsyslog omhttp, OTel). Stored as a string; the route splits lines.
  const rawString = (req, body, done) => done(null, body);
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, rawString);
  app.addContentTypeParser('application/x-ndjson', { parseAs: 'string' }, rawString);

  await app.register(fastifyJwt, { secret: config.jwtSecret });
  await app.register(fastifyRateLimit, {
    global: false,
    max: 600,
    timeWindow: '1 minute',
  });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    setHeaders(res, filePath) {
      // HTML must always be revalidated so users get new (version-tagged)
      // asset URLs right after a panel update; assets themselves may cache.
      if (filePath.endsWith('.html')) {
        res.setHeader('cache-control', 'no-cache');
      }
    },
  });

  // Health check (used by installer + monitoring).
  app.get('/api/v1/health', async () => ({ status: 'ok', version: CURRENT_VERSION, time: Math.floor(Date.now() / 1000) }));

  await app.register(authRoutes);
  await app.register(serverRoutes);
  await app.register(logRoutes);
  await app.register(ingestRoutes);
  await app.register(alertRoutes);
  await app.register(adminRoutes);
  await app.register(agentInstallRoutes);
  await app.register(streamRoutes);
  await app.register(systemRoutes);
  await app.register(auditRoutes);
  await app.register(metricsRoutes);
  await app.register(aiRoutes);
  await app.register(threatRoutes);

  // SPA fallback: serve index.html for non-API GET routes.
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api') && !request.url.startsWith('/agent')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });

  return app;
}

async function main() {
  seedDefaultRules();
  reloadRules();

  const app = await buildApp();
  startRetention(app.log);
  startHeartbeat(app.log);
  startUpdater(app.log);
  startAnomaly(app.log);
  if (config.syslogUdpPort) startSyslog(config.syslogUdpPort, app.log);

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`LogWatch Panel listening on http://${config.host}:${config.port} (public: ${config.publicUrl})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      app.log.info(`received ${sig}, shutting down`);
      await app.close();
      process.exit(0);
    });
  }
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
