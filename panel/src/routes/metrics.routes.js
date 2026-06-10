// Prometheus metrics endpoint (text exposition format) for enterprise
// observability. Protected by METRICS_TOKEN if configured.
import { db } from '../db/index.js';
import { config } from '../config.js';

export default async function metricsRoutes(app) {
  app.get('/metrics', async (request, reply) => {
    if (config.metricsToken) {
      const m = (request.headers.authorization || '').match(/^Bearer\s+(.+)$/);
      if (!m || m[1] !== config.metricsToken) {
        return reply.code(401).send('unauthorized');
      }
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const since = nowSec - 86400;
    const servers = db.prepare('SELECT COUNT(*) AS n FROM servers').get().n;
    const online = db
      .prepare("SELECT COUNT(*) AS n FROM servers WHERE status='online' AND last_seen >= ?")
      .get(nowSec - config.agentOfflineSeconds).n;
    const logsTotal = db.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
    const logs24 = db.prepare('SELECT COUNT(*) AS n FROM logs WHERE received_at >= ?').get(since).n;
    const errors24 = db
      .prepare("SELECT COUNT(*) AS n FROM logs WHERE received_at >= ? AND level IN ('error','critical')")
      .get(since).n;
    const alerts24 = db.prepare('SELECT COUNT(*) AS n FROM alert_events WHERE fired_at >= ?').get(since).n;
    const mem = process.memoryUsage();

    const lines = [
      '# HELP logwatch_servers_total Registered servers',
      '# TYPE logwatch_servers_total gauge',
      `logwatch_servers_total ${servers}`,
      '# HELP logwatch_servers_online Servers currently online',
      '# TYPE logwatch_servers_online gauge',
      `logwatch_servers_online ${online}`,
      '# HELP logwatch_logs_total Total stored log entries',
      '# TYPE logwatch_logs_total gauge',
      `logwatch_logs_total ${logsTotal}`,
      '# HELP logwatch_logs_24h Log entries in the last 24h',
      '# TYPE logwatch_logs_24h gauge',
      `logwatch_logs_24h ${logs24}`,
      '# HELP logwatch_errors_24h Error/critical entries in the last 24h',
      '# TYPE logwatch_errors_24h gauge',
      `logwatch_errors_24h ${errors24}`,
      '# HELP logwatch_alerts_24h Alerts fired in the last 24h',
      '# TYPE logwatch_alerts_24h gauge',
      `logwatch_alerts_24h ${alerts24}`,
      '# HELP logwatch_process_resident_memory_bytes Resident memory',
      '# TYPE logwatch_process_resident_memory_bytes gauge',
      `logwatch_process_resident_memory_bytes ${mem.rss}`,
      '# HELP logwatch_process_uptime_seconds Process uptime',
      '# TYPE logwatch_process_uptime_seconds counter',
      `logwatch_process_uptime_seconds ${Math.floor(process.uptime())}`,
      '',
    ];
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return lines.join('\n');
  });
}
