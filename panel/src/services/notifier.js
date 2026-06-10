// Notification delivery. Supports Discord webhooks, Gotify, Telegram and SMTP.
// Each channel stores its config as JSON in the `channels` table.
import { maskSecrets } from '../utils/normalize.js';

const LEVEL_COLOR = {
  critical: 0xb91c1c,
  error: 0xdc2626,
  warning: 0xd97706,
  notice: 0x2563eb,
  info: 0x059669,
  debug: 0x6b7280,
};

function fmtTitle(alert) {
  return `[${(alert.level || 'info').toUpperCase()}] ${alert.title}`;
}

// --- Discord ---------------------------------------------------------------
async function sendDiscord(cfg, alert) {
  if (!cfg.webhook_url) throw new Error('discord: webhook_url missing');
  const body = {
    username: cfg.username || 'LogWatch',
    embeds: [
      {
        title: fmtTitle(alert),
        description: '```\n' + maskSecrets(alert.message).slice(0, 1800) + '\n```',
        color: LEVEL_COLOR[alert.level] ?? LEVEL_COLOR.info,
        fields: [
          { name: 'Server', value: String(alert.server || 'n/a'), inline: true },
          { name: 'Source', value: String(alert.source || 'n/a'), inline: true },
          { name: 'Rule', value: String(alert.rule || 'n/a'), inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const res = await fetch(cfg.webhook_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`discord: HTTP ${res.status} ${await res.text().catch(() => '')}`);
}

// --- Gotify ----------------------------------------------------------------
async function sendGotify(cfg, alert) {
  if (!cfg.url || !cfg.token) throw new Error('gotify: url and token required');
  const base = cfg.url.replace(/\/$/, '');
  const priority = alert.level === 'critical' ? 10 : alert.level === 'error' ? 8 : alert.level === 'warning' ? 5 : 3;
  const res = await fetch(`${base}/message?token=${encodeURIComponent(cfg.token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: fmtTitle(alert),
      message: `Server: ${alert.server || 'n/a'} | Source: ${alert.source || 'n/a'}\n\n${maskSecrets(alert.message)}`,
      priority,
    }),
  });
  if (!res.ok) throw new Error(`gotify: HTTP ${res.status} ${await res.text().catch(() => '')}`);
}

// --- Telegram --------------------------------------------------------------
async function sendTelegram(cfg, alert) {
  if (!cfg.bot_token || !cfg.chat_id) throw new Error('telegram: bot_token and chat_id required');
  const text =
    `*${fmtTitle(alert).replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1')}*\n` +
    `Server: ${alert.server || 'n/a'}\nSource: ${alert.source || 'n/a'}\n\n` +
    '```\n' + maskSecrets(alert.message).slice(0, 3500) + '\n```';
  const res = await fetch(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chat_id, text, parse_mode: 'MarkdownV2' }),
  });
  if (!res.ok) throw new Error(`telegram: HTTP ${res.status} ${await res.text().catch(() => '')}`);
}

// --- SMTP (optional, requires nodemailer) ----------------------------------
async function sendSmtp(cfg, alert) {
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    throw new Error('smtp: nodemailer not installed (npm i nodemailer)');
  }
  if (!cfg.host || !cfg.from || !cfg.to) throw new Error('smtp: host, from and to required');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port || 587,
    secure: !!cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: fmtTitle(alert),
    text: `Server: ${alert.server || 'n/a'}\nSource: ${alert.source || 'n/a'}\nRule: ${alert.rule || 'n/a'}\n\n${maskSecrets(alert.message)}`,
  });
}

const SENDERS = { discord: sendDiscord, gotify: sendGotify, telegram: sendTelegram, smtp: sendSmtp };

// channel: { type, config(JSON string|object) }
export async function sendToChannel(channel, alert) {
  const sender = SENDERS[channel.type];
  if (!sender) throw new Error(`unknown channel type: ${channel.type}`);
  const cfg = typeof channel.config === 'string' ? JSON.parse(channel.config) : channel.config;
  await sender(cfg, alert);
}
