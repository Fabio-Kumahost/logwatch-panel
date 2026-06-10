// Public endpoints used by the agent installer one-liner:
//   GET /agent/install.sh            -> the installer script
//   GET /agent/download/:file        -> a compiled agent binary
// No auth here: the installer authenticates later with the per-server token.
// Binaries are not secret; the token is what grants ingest access.
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, '../../../scripts/agent-install.sh');
const binDir = resolve(__dirname, '../../', config.agentBinDir);

// Only allow well-formed binary names to be served.
const BIN_RE = /^logwatch-agent-(linux)-(amd64|arm64|armv7|386)$/;

export default async function agentInstallRoutes(app) {
  // Version of the agent binaries this panel distributes (written by `make
  // agent-all`). Public: agents poll it for self-updates before authenticating.
  app.get('/api/v1/agent/version', async (request, reply) => {
    try {
      const version = (await readFile(join(binDir, 'VERSION'), 'utf8')).trim();
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('malformed');
      return { version };
    } catch {
      return reply.code(404).send({ error: 'agent version unknown (agent-bin/VERSION missing)' });
    }
  });

  app.get('/agent/install.sh', async (request, reply) => {
    try {
      let script = await readFile(scriptPath, 'utf8');
      // Provide the panel URL as a default so a bare pipe still knows where to call back.
      script = script.replace('__PANEL_URL_DEFAULT__', config.publicUrl);
      reply.header('content-type', 'text/x-shellscript; charset=utf-8');
      return script;
    } catch {
      return reply.code(500).send('# installer script unavailable on this panel');
    }
  });

  app.get('/agent/download/:file', async (request, reply) => {
    const file = String(request.params.file);
    if (!BIN_RE.test(file)) return reply.code(400).send({ error: 'invalid binary name' });
    const full = join(binDir, file);
    try {
      const st = await stat(full);
      if (!st.isFile()) throw new Error('not a file');
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', st.size);
      reply.header('content-disposition', `attachment; filename="${file}"`);
      return reply.send(createReadStream(full));
    } catch {
      return reply
        .code(404)
        .send({ error: `binary not built yet: ${file}. Run the GitHub Actions build or 'make agent' and place it in agent-bin/.` });
    }
  });
}
