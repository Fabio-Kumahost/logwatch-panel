// Optional UDP syslog listener (RFC 3164 / 5424). Incoming messages are mapped
// to a registered server by source IP (servers.ingest_ip). Enabled only when
// SYSLOG_UDP_PORT > 0. There is no per-message auth in syslog, so mapping is by
// network identity — only logs from known IPs are accepted.
import dgram from 'node:dgram';
import { db } from '../db/index.js';
import { storeEntries, touchServer } from './ingest-core.js';

const SEVERITY = ['critical', 'critical', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];

// Parse "<PRI>..." — supports RFC3164 and 5424 enough to extract level/tag/msg.
function parseSyslog(line) {
  let level = null;
  let rest = line;
  const pri = /^<(\d{1,3})>/.exec(line);
  if (pri) {
    level = SEVERITY[Number(pri[1]) % 8] || 'info';
    rest = line.slice(pri[0].length);
  }
  // Strip a leading version digit (5424) or timestamp+host+tag (3164), best effort.
  let service = null;
  const tag = /^(?:\d\s+)?(?:\S+\s+){0,3}([A-Za-z0-9._/-]+)(?:\[\d+\])?:\s/.exec(rest);
  if (tag) service = tag[1].slice(0, 128);
  return { level, service, message: rest.trim() };
}

export function startSyslog(port, logger) {
  if (!port) return null;
  const sock = dgram.createSocket('udp4');

  sock.on('message', (buf, rinfo) => {
    try {
      const ip = rinfo.address.replace(/^::ffff:/, '');
      const server = db.prepare('SELECT * FROM servers WHERE ingest_ip = ?').get(ip);
      if (!server) return; // unknown source — ignore
      const parsed = parseSyslog(buf.toString('utf8'));
      if (!parsed.message) return;
      touchServer(server);
      storeEntries(server, [{ source: 'syslog', service: parsed.service, level: parsed.level, host: ip, message: parsed.message }], logger);
    } catch (err) {
      logger?.error?.(`[syslog] ${err.message}`);
    }
  });
  sock.on('error', (err) => logger?.error?.(`[syslog] socket error: ${err.message}`));
  sock.bind(port, () => logger?.info?.(`[syslog] UDP listener on :${port} (map sources via server ingest_ip)`));
  return sock;
}
