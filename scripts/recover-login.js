/**
 * recover-login.js
 * Lists all users in the local Electron DB and resets the password for
 * the first admin account (or a specific email you set below).
 *
 * Usage:
 *   node scripts/recover-login.js
 *   node scripts/recover-login.js <email> <newpassword>
 *
 * It automatically finds the Electron userData DB path.
 */
'use strict';

const path  = require('path');
const fs    = require('fs');
const bcrypt = require('bcryptjs');

// ─── Resolve DB path (same logic as server/db.js) ───────────────────────────
const ELECTRON_USER_DATA = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'ai-content-studio'
);
const DB_PATH = path.join(ELECTRON_USER_DATA, 'data', 'saas.db');

if (!fs.existsSync(DB_PATH)) {
  console.error('❌ DB not found at:', DB_PATH);
  process.exit(1);
}

const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─── Show all users ───────────────────────────────────────────────────────────
const users = db.prepare('SELECT id, email, name, is_admin, is_owner, verified FROM users').all();
console.log('\n📋 Users in local DB:');
console.log('─'.repeat(70));
users.forEach((u, i) => {
  const role = u.is_owner ? '👑 OWNER' : u.is_admin ? '🔑 ADMIN' : '👤 user';
  const ver  = u.verified  ? '✅' : '❌ unverified';
  console.log(`${i + 1}. ${u.email} (${u.name}) ${role} ${ver}`);
});
console.log('─'.repeat(70));

if (users.length === 0) {
  console.log('\n⚠️  No users found. The DB might be empty or on wrong path.');
  db.close();
  process.exit(0);
}

// ─── Password reset ────────────────────────────────────────────────────────
const [,, targetEmail, newPassword] = process.argv;

async function resetPassword(email, newPwd) {
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) {
    console.error(`\n❌ No user found with email: ${email}`);
    db.close();
    process.exit(1);
  }
  const hash = await bcrypt.hash(newPwd, 12);
  db.prepare('UPDATE users SET password_hash = ?, verified = 1, reset_token = NULL WHERE id = ?').run(hash, user.id);
  console.log(`\n✅ Password reset for: ${email}`);
  console.log(`   New password: ${newPwd}`);
  console.log('\n   You can now log in to the app with these credentials.\n');
  db.close();
}

if (targetEmail && newPassword) {
  resetPassword(targetEmail, newPassword);
} else if (users.length === 1) {
  // Auto-target single account
  const autoEmail = users[0].email;
  const autoPwd   = 'Kyros2026!';
  console.log(`\n🔧 Single user found. Auto-resetting password for: ${autoEmail}`);
  console.log(`   New temporary password: ${autoPwd}`);
  resetPassword(autoEmail, autoPwd);
} else {
  console.log('\nTo reset a password, run:');
  console.log('  node scripts/recover-login.js <email> <newpassword>');
  console.log('\nExample:');
  console.log(`  node scripts/recover-login.js ${users[0].email} MyNewPassword123`);
  db.close();
}
