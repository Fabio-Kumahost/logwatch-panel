// System endpoints: update check against GitHub + one-click update trigger.
import { writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requireUser, requireRole } from '../auth/middleware.js';
import { getUpdateStatus, checkForUpdate, REPO } from '../services/updater.js';
import { config } from '../config.js';

const UPDATE_COMMAND = `curl -sSL https://raw.githubusercontent.com/${REPO}/main/scripts/update.sh | sudo bash`;

// The panel is sandboxed (read-only FS except its data dir). Dropping this file
// is its only way to request an update; a root systemd path-unit picks it up
// and runs scripts/update.sh.
const TRIGGER_FILE = resolve(process.cwd(), dirname(config.dbPath), 'update-requested');
const UPDATER_UNIT = '/etc/systemd/system/logwatch-panel-updater.path';

export default async function systemRoutes(app) {
  // Cached status (refreshed every 6h by the background updater).
  app.get('/api/v1/system/update', { preHandler: requireUser }, async () => ({
    ...getUpdateStatus(),
    update_command: UPDATE_COMMAND,
  }));

  // Force a re-check now (e.g. "Check now" button).
  app.post('/api/v1/system/update/check', { preHandler: requireRole('operator') }, async (request) => ({
    ...(await checkForUpdate(request.log)),
    update_command: UPDATE_COMMAND,
  }));

  // One-click update: write the trigger file for the root updater unit.
  app.post('/api/v1/system/update/apply', { preHandler: requireRole('admin') }, async (request, reply) => {
    try {
      await access(UPDATER_UNIT);
    } catch {
      return reply.code(409).send({
        error:
          'One-click updater is not installed on this host yet. Run the manual update command once — it installs the updater for next time.',
        update_command: UPDATE_COMMAND,
      });
    }
    try {
      await writeFile(TRIGGER_FILE, `requested ${new Date().toISOString()}\n`);
    } catch (err) {
      return reply.code(500).send({ error: `could not write update trigger: ${err.message}` });
    }
    request.log.info('[updater] one-click update requested via UI');
    return { ok: true, started: true };
  });
}
