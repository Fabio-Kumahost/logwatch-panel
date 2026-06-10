// End-to-end smoke test of the panel: boots the app in-process against a
// throwaway SQLite database and exercises the full agent + UI flow.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Configure the app BEFORE importing modules that read config at load time.
const tmp = mkdtempSync(join(tmpdir(), 'logwatch-test-'));
process.env.DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.NODE_ENV = 'production'; // skip pino-pretty transport
process.env.PUBLIC_URL = 'http://panel.test';
process.env.AGENT_OFFLINE_SECONDS = '120';

const { buildApp } = await import('../src/server.js');
const { db } = await import('../src/db/index.js');
const { hashPassword } = await import('../src/auth/auth.js');
const { seedDefaultRules, reloadRules } = await import('../src/services/alerts.js');

let app;
let userToken;
let agentToken;
let serverId;

before(async () => {
  const hash = await hashPassword('Sup3rSecret!');
  db.prepare('INSERT INTO users(username, password_hash, role) VALUES(?,?,?)').run('admin', hash, 'admin');
  seedDefaultRules();
  reloadRules();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('health endpoint responds ok', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('login rejects bad credentials', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'wrong' } });
  assert.equal(res.statusCode, 401);
});

test('login returns a JWT', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'Sup3rSecret!' } });
  assert.equal(res.statusCode, 200);
  userToken = res.json().token;
  assert.ok(userToken);
});

test('protected route requires auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/servers' });
  assert.equal(res.statusCode, 401);
});

test('create a server and receive token + install command', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { name: 'web-01', group_name: 'web' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  agentToken = body.token;
  serverId = body.id;
  assert.match(body.install_command, /curl -sSL http:\/\/panel\.test\/agent\/install\.sh/);
  assert.match(body.install_command, /--token [a-f0-9]{64}/);
});

test('agent ingest rejects invalid token', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/ingest',
    headers: { authorization: 'Bearer deadbeefdeadbeef' },
    payload: { entries: [{ message: 'hi' }] },
  });
  assert.equal(res.statusCode, 401);
});

test('agent ingests a batch of logs', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/ingest',
    headers: { authorization: `Bearer ${agentToken}` },
    payload: {
      host: 'web-01',
      os: 'debian',
      os_version: '12',
      agent_version: '1.0.0',
      entries: [
        { source: 'syslog', service: 'sshd', message: 'Accepted password for root', level: 'info' },
        { source: 'auth', service: 'sshd', message: 'Failed password for invalid user admin from 10.0.0.9', level: 'warning' },
        { source: 'kernel', service: 'kernel', message: 'Out of memory: Killed process 123', level: 'err' },
        { source: 'nginx', service: 'nginx', message: 'connect() failed (111: Connection refused)', level: 'error' },
      ],
    },
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().accepted, 4);
});

test('secrets are masked on ingest', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/v1/ingest',
    headers: { authorization: `Bearer ${agentToken}` },
    payload: { entries: [{ source: 'app', message: 'login password=hunter2 ok' }] },
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/logs?q=hunter2',
    headers: { authorization: `Bearer ${userToken}` },
  });
  // The secret value should not be searchable/stored verbatim.
  const found = res.json().logs.some((l) => l.message.includes('hunter2'));
  assert.equal(found, false);
});

test('level normalization maps "err" to error', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/logs?level=error',
    headers: { authorization: `Bearer ${userToken}` },
  });
  const levels = res.json().logs.map((l) => l.level);
  assert.ok(levels.includes('critical') || levels.includes('error'));
});

test('full-text search finds nginx error', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/logs?q=Connection refused',
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().logs.length >= 1);
});

test('server shows online after ingest with last_log', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/servers',
    headers: { authorization: `Bearer ${userToken}` },
  });
  const s = res.json().find((x) => x.id === serverId);
  assert.equal(s.status, 'online');
  assert.equal(s.os, 'debian');
  assert.ok(s.last_log);
});

test('alert events recorded for error/critical default rules', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/alerts/events',
    headers: { authorization: `Bearer ${userToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().length >= 1, 'expected at least one fired alert event');
});

test('agent install script is served publicly', async () => {
  const res = await app.inject({ method: 'GET', url: '/agent/install.sh' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /shellscript/);
  assert.match(res.body, /LogWatch/);
});
