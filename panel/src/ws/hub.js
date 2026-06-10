// In-process pub/sub hub for the live log stream. Ingest publishes new entries;
// WebSocket and SSE clients subscribe with optional filters.
import { EventEmitter } from 'node:events';
import { LEVEL_RANK } from '../utils/normalize.js';

class LogHub extends EventEmitter {
  publish(entry) {
    this.emit('log', entry);
  }
}

export const hub = new LogHub();
hub.setMaxListeners(0); // many concurrent stream clients

// Returns true if a log entry matches a client's filter set.
export function matchesFilter(entry, filter) {
  if (!filter) return true;
  if (filter.serverId && Number(filter.serverId) !== entry.server_id) return false;
  if (filter.source && filter.source !== entry.source) return false;
  if (filter.service && filter.service !== entry.service) return false;
  if (filter.minLevel) {
    const want = LEVEL_RANK[filter.minLevel] ?? 0;
    const have = LEVEL_RANK[entry.level] ?? 0;
    if (have < want) return false;
  }
  return true;
}
