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
    || (process.env.NODE_ENV === 'production' && fs.existsSync('/data') ? '/data' : null)
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
  if (userCols.length > 0 && !userCols.some((c) => c.name === 'referral_code')) {
    db.exec('ALTER TABLE users ADD COLUMN referral_code TEXT');
  }
  if (userCols.length > 0 && !userCols.some((c) => c.name === 'referred_by')) {
    db.exec('ALTER TABLE users ADD COLUMN referred_by TEXT REFERENCES users(id) ON DELETE SET NULL');
  }
  if (userCols.length > 0 && !userCols.some((c) => c.name === 'is_owner')) {
    db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0');
  }
} catch (e) {
  // Users table may not exist yet; CREATE TABLE below will handle it
}

// generation_jobs gained gallery_ids on 2026-08-15: one render can return several images, and the
// queue was recording only the first. CREATE TABLE IF NOT EXISTS never alters an existing table,
// so a database made yesterday needs this.
try {
  const jobCols = db.pragma('table_info(generation_jobs)');
  if (jobCols.length > 0 && !jobCols.some((c) => c.name === 'gallery_ids')) {
    db.exec('ALTER TABLE generation_jobs ADD COLUMN gallery_ids TEXT');
  }
  if (jobCols.length > 0 && !jobCols.some((c) => c.name === 'result_json')) {
    db.exec('ALTER TABLE generation_jobs ADD COLUMN result_json TEXT');
  }
  if (jobCols.length > 0 && !jobCols.some((c) => c.name === 'tags')) {
    db.exec('ALTER TABLE generation_jobs ADD COLUMN tags TEXT');
  }
} catch (e) {
  // Table not created yet; the CREATE TABLE below carries the column.
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
    is_owner   INTEGER NOT NULL DEFAULT 0,
    is_banned  INTEGER NOT NULL DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
    ON users(referral_code) WHERE referral_code IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan       TEXT NOT NULL DEFAULT 'free',
    status     TEXT NOT NULL DEFAULT 'active',
    heleket_order_id TEXT UNIQUE,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);

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

  CREATE TABLE IF NOT EXISTS desktop_license_activations (
    license_id TEXT PRIMARY KEY,
    customer_email TEXT NOT NULL,
    machine_fingerprint TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT '',
    expires_at INTEGER,
    activated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_desktop_license_activations_email
    ON desktop_license_activations(customer_email);

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

  /**
   * The DURABLE generation queue (owner, 2026-08-14).
   *
   * generation_runs above is an audit trail — it records that something happened. This holds the
   * work itself, so a run survives the app closing, an update, or a crash.
   *
   * WHY IT CAN WORK AT ALL: Muapi is submit-then-poll. generateSeedreamEdit gets a request_id back
   * and then polls it to completion inside one HTTP request, so today an app that dies mid-render
   * throws away a picture that Muapi has already produced and already billed. Persisting that id is
   * the whole trick: on the next boot the job is still pollable and the image is still retrievable.
   *
   * WHY filed IS SEPARATE FROM status: the Eddy libraries are IndexedDB, inside the browser.
   * The server cannot write to them. So the server takes a job as far as done with a gallery_id,
   * and the CLIENT files it into the chosen collection on load and flips filed. Two owners, two
   * flags — collapsing them would mean a job counted as complete while its picture had reached no
   * library at all.
   *
   * (No backticks anywhere in this comment: it lives inside a template literal, and one would end
   * the string and take the whole server's schema with it. It did, once.)
   *
   * dest_db / dest_folder are captured at ENQUEUE time, not read at filing time: the destination a
   * run was started with is the one it should land in, even if the dropdown has been changed twice
   * since.
   */
  CREATE TABLE IF NOT EXISTS generation_jobs (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature      TEXT NOT NULL,
    status       TEXT NOT NULL,
    task_id      TEXT,
    payload      TEXT NOT NULL,
    dest_db      TEXT,
    dest_folder  TEXT,
    card_prompt  TEXT,
    card_name    TEXT,
    gallery_id   TEXT,
    -- Every gallery id this job produced, JSON. gallery_id above stays as the FIRST one so
    -- existing readers keep working; this exists because a single render can return several
    -- images and keeping only images[0] silently threw the rest away.
    gallery_ids  TEXT,
    -- The FULL result rows, JSON: [{ galleryId, imageId, mimeType }]. Exists so a queued job can
    -- answer with the same shape /api/seedream/edit does, which is what lets a page swap one call
    -- for the other instead of being rewritten around a new contract.
    result_json  TEXT,
    -- Gallery provenance tags, so a recovered image can be identified by character.
    tags         TEXT,
    filed        INTEGER NOT NULL DEFAULT 0,
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  -- The worker's hot path: "what is queued, and what is still in flight".
  CREATE INDEX IF NOT EXISTS idx_generation_jobs_status
    ON generation_jobs(status, created_at);

  -- The client's boot question: "what finished while I was gone that I have not filed".
  CREATE INDEX IF NOT EXISTS idx_generation_jobs_unfiled
    ON generation_jobs(user_id, filed, status);

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

  CREATE TABLE IF NOT EXISTS login_lockouts (
    login       TEXT NOT NULL PRIMARY KEY,
    fail_count  INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_messages (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    admin_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    subject       TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    read_at       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_admin_messages_user_created
    ON admin_messages(user_id, created_at);

  CREATE TABLE IF NOT EXISTS referral_commissions (
    id          TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan        TEXT NOT NULL,
    amount_usd  REAL NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'pending',
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_referral_commissions_referrer_created
    ON referral_commissions(referrer_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_referral_commissions_referee_plan
    ON referral_commissions(referee_id, plan);
  CREATE INDEX IF NOT EXISTS idx_referral_commissions_status
    ON referral_commissions(status);
`);

// Best-effort unique index on heleket_order_id — skipped silently if duplicates exist in old data
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_heleket_order_id
    ON subscriptions(heleket_order_id) WHERE heleket_order_id IS NOT NULL`);
} catch (e) {
  console.warn('[db] Could not create heleket_order_id unique index (duplicate data?):', e.message);
}

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

// SEED_ADMIN_EMAIL is always the app owner (can grant owner role to others)
if (process.env.SEED_ADMIN_EMAIL) {
  try {
    const r = db.prepare('UPDATE users SET is_owner=1, is_admin=1 WHERE email=?').run(process.env.SEED_ADMIN_EMAIL.toLowerCase());
    if (r.changes > 0) console.log('[db] Owner promoted:', process.env.SEED_ADMIN_EMAIL.toLowerCase());
  } catch (e) {
    console.error('[db] Owner seed failed:', e.message);
  }
}


// Seed a default account on first boot if no users exist
try {
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  if (userCount.cnt === 0) {
    const { v4: uuidv4 } = require('uuid');
    const defaultEmail = 'kyros@studio.app';
    const hash = bcrypt.hashSync('Kyros2024!', 10);
    const userId = uuidv4();
    db.prepare('INSERT INTO users (id, email, password_hash, name, verified, is_admin) VALUES (?,?,?,?,1,1)')
      .run(userId, defaultEmail, hash, 'Kyros User');
    db.prepare('INSERT INTO subscriptions (id, user_id, plan, status) VALUES (?,?,?,?)')
      .run(uuidv4(), userId, 'unlimited', 'active');
    console.log('[db] Default account seeded:', defaultEmail);
  }
} catch (e) {
  console.error('[db] Default seed failed:', e.message);
}

module.exports = db;
