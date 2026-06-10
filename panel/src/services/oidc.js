// OpenID Connect SSO — Authorization Code flow with PKCE. Dependency-free
// (uses global fetch + node:crypto). Disabled unless configured (see config.js).
import { createHash, randomBytes } from 'node:crypto';
import { oidc } from '../config.js';
import { db } from '../db/index.js';

let discoveryCache = null;
// state -> { verifier, nonce, createdAt }. Short-lived, single-use (CSRF guard).
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isEnabled() {
  return oidc.enabled;
}

export async function discover() {
  if (discoveryCache) return discoveryCache;
  const res = await fetch(`${oidc.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('OIDC discovery document missing endpoints');
  }
  discoveryCache = doc;
  return doc;
}

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of stateStore) if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
}

// Begin login: returns the provider authorize URL and stashes PKCE state.
export async function buildAuthUrl() {
  const doc = await discover();
  pruneStates();
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  stateStore.set(state, { verifier, nonce, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: oidc.clientId,
    redirect_uri: oidc.redirectUri,
    scope: oidc.scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${doc.authorization_endpoint}?${params.toString()}`;
}

// Validate the callback state (single-use) and exchange the code for tokens,
// then fetch the userinfo claims.
export async function handleCallback(code, state) {
  const entry = stateStore.get(state);
  if (!entry) throw new Error('invalid or expired SSO state');
  stateStore.delete(state); // single use

  const doc = await discover();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oidc.redirectUri,
    client_id: oidc.clientId,
    client_secret: oidc.clientSecret,
    code_verifier: entry.verifier,
  });
  const tokenRes = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: HTTP ${tokenRes.status}`);
  const tokens = await tokenRes.json();
  if (!tokens.access_token) throw new Error('token response missing access_token');

  let claims = {};
  if (doc.userinfo_endpoint) {
    const uiRes = await fetch(doc.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (uiRes.ok) claims = await uiRes.json();
  }
  return claims;
}

// Map verified claims to a panel user, creating one on first login.
export function provisionUser(claims, hashPassword) {
  const email = (claims.email || '').toLowerCase();
  const sub = claims.sub;
  const username = email || (claims.preferred_username || sub);
  if (!username) throw new Error('SSO profile has no email/subject');

  if (oidc.allowedDomains.length && email) {
    const domain = email.split('@')[1] || '';
    if (!oidc.allowedDomains.includes(domain)) {
      throw new Error(`email domain "${domain}" is not allowed`);
    }
  }

  let user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
  if (!user) {
    // Random unusable password hash — SSO users can't log in with a password.
    const unusable = `sso!${b64url(randomBytes(24))}`;
    const info = db
      .prepare('INSERT INTO users(username, password_hash, role) VALUES(?,?,?)')
      .run(username, unusable, oidc.defaultRole);
    user = { id: info.lastInsertRowid, username, role: oidc.defaultRole };
  }
  db.prepare("UPDATE users SET last_login = strftime('%s','now') WHERE id = ?").run(user.id);
  return user;
}

export const oidcConfig = oidc;
