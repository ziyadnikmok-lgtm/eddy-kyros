'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const projectRoot = path.join(__dirname, '..');
const isTestRuntime = process.env.NODE_ENV === 'test' || !!process.env.VITEST;

function getDbPath() {
  if (isTestRuntime) {
    const os = require('os');
    return path.join(os.tmpdir(), 'ai-content-studio-test-data', `pid-${process.pid}`, 'saas.db');
  }
  // Shared DB (not per-user): lives at WEB_DATA_ROOT/saas.db
  // ELECTRON_USER_DATA is set by electron/main.js to app.getPath('userData')
  const WEB_DATA_ROOT = process.env.WEB_DATA_ROOT
    || (process.env.ELECTRON_USER_DATA ? path.join(process.env.ELECTRON_USER_DATA, 'data') : null)
    || path.join(projectRoot, 'userdata');
  return path.join(WEB_DATA_ROOT, 'saas.db');
}

const dbPath = getDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrate sessions table: rename 'expired' column to 'expire' if needed
try {
  const cols = db.pragma('table_info(sessions)');
  const hasExpired = cols.some(c => c.name === 'expired');
  const hasExpire  = cols.some(c => c.name === 'expire');
  if (hasExpired && !hasExpire) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_new (
        sid    TEXT NOT NULL PRIMARY KEY,
        sess   JSON NOT NULL,
        expire TEXT NOT NULL
      );
      INSERT INTO sessions_new (sid, sess, expire)
        SELECT sid, sess, expired FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
    console.log('[db] Migrated sessions table: expired → expire');
  }
} catch (e) {
  // Table may not exist yet — that's fine, CREATE TABLE below will handle it
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    verified   INTEGER NOT NULL DEFAULT 0,
    verification_token TEXT,
    reset_token TEXT,
    reset_token_expiry TEXT,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    is_banned  INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan       TEXT NOT NULL DEFAULT 'free',
    status     TEXT NOT NULL DEFAULT 'active',
    heleket_order_id TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_api_keys (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_name TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, service_name)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid    TEXT NOT NULL PRIMARY KEY,
    sess   JSON NOT NULL,
    expire TEXT NOT NULL
  );
`);

// Seed admin user: if SEED_ADMIN_EMAIL is set, promote that user to verified admin
if (process.env.SEED_ADMIN_EMAIL) {
  try {
    const result = db.prepare('UPDATE users SET verified=1, is_admin=1 WHERE email=?').run(process.env.SEED_ADMIN_EMAIL.toLowerCase());
    if (result.changes > 0) {
      console.log('[db] Admin promoted:', process.env.SEED_ADMIN_EMAIL);
    }
  } catch (e) {
    console.error('[db] Admin seed failed:', e.message);
  }
}


module.exports = db;
