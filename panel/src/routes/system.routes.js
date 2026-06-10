// System endpoints: update check against GitHub.
import { requireUser, requireRole } from '../auth/middleware.js';
import { getUpdateStatus, checkForUpdate, REPO } from '../services/updater.js';

const UPDATE_COMMAND = `curl -sSL https://raw.githubusercontent.com/${REPO}/main/scripts/update.sh | sudo bash`;

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
}
