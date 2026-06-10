import { requireRole } from '../auth/middleware.js';
import { list } from '../services/audit.js';

export default async function auditRoutes(app) {
  app.get('/api/v1/audit', { preHandler: requireRole('admin') }, async (request) => {
    const limit = parseInt(request.query.limit || '200', 10) || 200;
    return list(limit);
  });

  // CSV export of the audit trail.
  app.get('/api/v1/audit/export.csv', { preHandler: requireRole('admin') }, async (request, reply) => {
    const rows = list(parseInt(request.query.limit || '1000', 10) || 1000);
    const header = 'time,user,action,target,detail,ip\n';
    const csv = header + rows.map((r) =>
      [new Date(r.ts * 1000).toISOString(), r.username || '', r.action, r.target || '', r.detail || '', r.ip || '']
        .map((f) => `"${String(f).replace(/"/g, '""')}"`)
        .join(',')
    ).join('\n');
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="logwatch-audit.csv"');
    return csv;
  });
}
