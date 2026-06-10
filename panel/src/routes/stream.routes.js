// Real-time log streaming via WebSocket (primary) and Server-Sent Events
// (fallback). Both authenticate with the panel JWT passed as a query parameter,
// since browsers cannot attach Authorization headers to these connections.
import { hub, matchesFilter } from '../ws/hub.js';

function verifyToken(app, token) {
  try {
    return app.jwt.verify(token);
  } catch {
    return null;
  }
}

function filterFromQuery(q) {
  return {
    serverId: q.server_id ? Number(q.server_id) : null,
    source: q.source || null,
    service: q.service || null,
    minLevel: q.level || null,
  };
}

export default async function streamRoutes(app) {
  // ---- WebSocket ----
  app.get('/api/v1/stream', { websocket: true }, (socket, request) => {
    const user = verifyToken(app, request.query.token);
    if (!user) {
      try { socket.close(1008, 'unauthorized'); } catch { /* ignore */ }
      return;
    }
    const filter = filterFromQuery(request.query);
    const onLog = (entry) => {
      if (!matchesFilter(entry, filter)) return;
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(entry));
      }
    };
    hub.on('log', onLog);
    socket.send(JSON.stringify({ _type: 'connected', ts: Math.floor(Date.now() / 1000) }));
    socket.on('close', () => hub.off('log', onLog));
    socket.on('error', () => hub.off('log', onLog));
  });

  // ---- Server-Sent Events fallback ----
  app.get('/api/v1/stream/sse', (request, reply) => {
    const user = verifyToken(app, request.query.token);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const filter = filterFromQuery(request.query);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`event: connected\ndata: {}\n\n`);

    const onLog = (entry) => {
      if (!matchesFilter(entry, filter)) return;
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    hub.on('log', onLog);

    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
    ping.unref();
    request.raw.on('close', () => {
      clearInterval(ping);
      hub.off('log', onLog);
    });
  });
}
