// Migration / seed entrypoint. Importing ./index.js applies the schema.
// With --seed-admin it creates the initial admin account from environment
// variables (ADMIN_USER / ADMIN_PASS) if no users exist yet. The installer
// calls this so credentials never need to be hardcoded.
import { db } from './index.js';
import { hashPassword } from '../auth/auth.js';

async function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) {
    console.log('[migrate] users already exist — skipping admin seed.');
    return;
  }
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASS;
  if (!password) {
    console.error('[migrate] ADMIN_PASS is required to seed the admin account.');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  db.prepare('INSERT INTO users(username, password_hash, role) VALUES(?,?,?)').run(
    username,
    hash,
    'admin'
  );
  console.log(`[migrate] created admin user "${username}".`);
}

const args = process.argv.slice(2);
console.log('[migrate] schema applied.');
if (args.includes('--seed-admin')) {
  await seedAdmin();
}
process.exit(0);
