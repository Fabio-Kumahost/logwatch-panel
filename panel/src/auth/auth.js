// Password hashing (bcrypt) and agent-token helpers.
import bcrypt from 'bcryptjs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

// Agent tokens are random 32-byte values. We store only their SHA-256 hash and
// compare in constant time, so a database leak does not expose usable tokens.
export function generateAgentToken() {
  return randomBytes(32).toString('hex');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
