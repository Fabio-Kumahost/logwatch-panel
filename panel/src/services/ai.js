// Optional AI assistant powered by Claude. Two capabilities:
//   - explain(): root-cause analysis + fix for a log line
//   - nlSearch(): turn a natural-language query into a logs filter
// Disabled unless ANTHROPIC_API_KEY is set. Uses the official @anthropic-ai/sdk.
import { config } from '../config.js';
import { LEVELS } from '../utils/normalize.js';

let clientPromise = null;

export function aiEnabled() {
  return !!config.anthropicApiKey;
}

async function getClient() {
  if (!aiEnabled()) throw new Error('AI is not configured (set ANTHROPIC_API_KEY)');
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then((m) => new m.default({ apiKey: config.anthropicApiKey }))
      .catch((err) => {
        clientPromise = null;
        throw new Error(`@anthropic-ai/sdk not installed: ${err.message}`);
      });
  }
  return clientPromise;
}

function firstText(message) {
  for (const block of message.content || []) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

// Explain a log entry: what it means, why it happens, and how to fix it.
export async function explain(entry) {
  const client = await getClient();
  const ctx = [
    entry.server_name ? `Server: ${entry.server_name}` : null,
    entry.source ? `Source: ${entry.source}` : null,
    entry.service ? `Service: ${entry.service}` : null,
    entry.level ? `Level: ${entry.level}` : null,
  ].filter(Boolean).join(' · ');
  const message = await client.messages.create({
    model: config.aiModel,
    max_tokens: 1024,
    system:
      'You are a senior Linux/SRE engineer helping triage a log entry from a server monitoring panel. ' +
      'Be concise and practical. Reply in GitHub-flavored Markdown with three short sections: ' +
      '**What it means**, **Likely cause**, **How to fix** (concrete shell commands where useful). ' +
      'Do not invent details not implied by the log.',
    messages: [
      { role: 'user', content: `${ctx}\n\nLog line:\n${String(entry.message).slice(0, 4000)}` },
    ],
  });
  return firstText(message).trim();
}

// Translate a natural-language query into a structured logs filter.
export async function nlSearch(query) {
  const client = await getClient();
  const message = await client.messages.create({
    model: config.aiModel,
    max_tokens: 512,
    system:
      'Convert the user request into a log search filter for a Linux log panel. ' +
      'Use empty string or 0 for fields that do not apply. "hours" is how far back to search.',
    messages: [{ role: 'user', content: String(query).slice(0, 500) }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'full-text keywords' },
            level: { type: 'string', enum: ['', ...LEVELS], description: 'minimum level' },
            source: { type: 'string', description: 'e.g. nginx, kernel, auth, docker' },
            service: { type: 'string' },
            hours: { type: 'integer', description: 'lookback window in hours, 0 = no limit' },
          },
          required: ['q', 'level', 'source', 'service', 'hours'],
          additionalProperties: false,
        },
      },
    },
  });
  const raw = firstText(message);
  let filter = {};
  try { filter = JSON.parse(raw); } catch { /* ignore */ }
  // Build query params the /logs endpoint understands.
  const params = {};
  if (filter.q) params.q = filter.q;
  if (filter.level && LEVELS.includes(filter.level)) params.level = filter.level;
  if (filter.source) params.source = filter.source;
  if (filter.service) params.service = filter.service;
  if (filter.hours && filter.hours > 0) params.from = Math.floor(Date.now() / 1000) - filter.hours * 3600;
  return { filter, params };
}
