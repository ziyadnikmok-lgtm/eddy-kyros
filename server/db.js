'use strict';
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
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

try {
  const userCols = db.pragma('table_info(users)');
  if (userCols.length > 0 && !userCols.some((c) => c.name === 'username')) {
    db.exec('ALTER TABLE users ADD COLUMN username TEXT');
  }
} catch (e) {
  // Users table may not exist yet; CREATE TABLE below will handle it
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    username   TEXT UNIQUE COLLATE NOCASE,
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
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

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

  CREATE TABLE IF NOT EXISTS usage_events (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
    event_type  TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    source      TEXT,
    payload_json TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_usage_events_type_created
    ON usage_events(event_type, created_at);

  CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
    ON usage_events(user_id, created_at);

  CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id            TEXT PRIMARY KEY,
    admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action_type   TEXT NOT NULL,
    before_json   TEXT,
    after_json    TEXT,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
    ON admin_audit_logs(created_at);

  CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target_created
    ON admin_audit_logs(target_user_id, created_at);

  CREATE TABLE IF NOT EXISTS generation_runs (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature       TEXT NOT NULL,
    provider      TEXT,
    model         TEXT,
    status        TEXT NOT NULL,
    error_code    TEXT,
    error_message TEXT,
    output_count  INTEGER NOT NULL DEFAULT 0,
    started_at    TEXT NOT NULL,
    finished_at   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_generation_runs_user_started
    ON generation_runs(user_id, started_at);

  CREATE INDEX IF NOT EXISTS idx_generation_runs_feature_started
    ON generation_runs(feature, started_at);

  CREATE INDEX IF NOT EXISTS idx_generation_runs_status_started
    ON generation_runs(status, started_at);

  CREATE TABLE IF NOT EXISTS support_notes (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    admin_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_support_notes_user_created
    ON support_notes(user_id, created_at);
`);

// Seed or create an admin user when explicit bootstrap env vars are present.
if (process.env.SEED_ADMIN_EMAIL) {
  try {
    const adminEmail = process.env.SEED_ADMIN_EMAIL.toLowerCase();
    const adminUsername = (process.env.SEED_ADMIN_USERNAME || 'admin').trim().toLowerCase() || 'admin';
    const adminName = (process.env.SEED_ADMIN_NAME || 'Admin').trim() || 'Admin';
    const passwordHash = process.env.SEED_ADMIN_PASSWORD
      ? bcrypt.hashSync(process.env.SEED_ADMIN_PASSWORD, 12)
      : null;
    const existingByEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
    const existingByUsername = db.prepare('SELECT id, email FROM users WHERE username = ?').get(adminUsername);

    if (existingByUsername && existingByUsername.email !== adminEmail) {
      console.warn('[db] Admin username already belongs to another account:', adminUsername);
    } else if (existingByEmail) {
      if (passwordHash) {
        db.prepare(`
          UPDATE users
          SET verified = 1, is_admin = 1, username = ?, name = ?, password_hash = ?
          WHERE email = ?
        `).run(adminUsername, adminName, passwordHash, adminEmail);
      } else {
        db.prepare(`
          UPDATE users
          SET verified = 1, is_admin = 1, username = ?, name = ?
          WHERE email = ?
        `).run(adminUsername, adminName, adminEmail);
      }
      console.log('[db] Admin promoted:', adminEmail);
    } else if (passwordHash) {
      db.prepare(`
        INSERT INTO users (id, email, username, password_hash, name, verified, is_admin)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 1, 1)
      `).run(adminEmail, adminUsername, passwordHash, adminName);
      db.prepare(`
        INSERT INTO subscriptions (id, user_id, plan, status)
        VALUES (lower(hex(randomblob(16))), (SELECT id FROM users WHERE email = ?), 'unlimited', 'active')
      `).run(adminEmail);
      console.log('[db] Admin account created:', adminEmail);
    } else {
      const result = db.prepare('UPDATE users SET verified=1, is_admin=1, username=?, name=? WHERE email=?').run(adminUsername, adminName, adminEmail);
      if (result.changes > 0) {
        console.log('[db] Admin promoted:', adminEmail);
      } else {
        console.warn('[db] SEED_ADMIN_EMAIL is set but no matching user exists and SEED_ADMIN_PASSWORD is missing');
      }
    }
  } catch (e) {
    console.error('[db] Admin seed failed:', e.message);
  }
}


module.exports = db;
