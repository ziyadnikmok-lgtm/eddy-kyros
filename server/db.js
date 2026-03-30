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
  const WEB_DATA_ROOT = process.env.WEB_DATA_ROOT || path.join(projectRoot, 'userdata');
  return path.join(WEB_DATA_ROOT, 'saas.db');
}

const dbPath = getDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

module.exports = db;
