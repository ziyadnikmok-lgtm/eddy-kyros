'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { logUsageEvent } = require('../services/eventLogger');
const log = require('../utils/logger');

const router = express.Router();

// Account lockout: max 5 failed attempts per login, locked 15 min — persisted in DB
const LOCKOUT_MAX = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase();
}

function getUserByLogin(login) {
  return db.prepare(`
    SELECT *
    FROM users
    WHERE email = ?
       OR username = ?
  `).get(login, login);
}

function checkLockout(login) {
  const row = db.prepare('SELECT fail_count, locked_until FROM login_lockouts WHERE login = ?').get(login);
  if (!row) return null;
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(row.locked_until) - Date.now()) / 60000);
    return `Too many failed attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`;
  }
  return null;
}

function recordFailedLogin(login) {
  const row = db.prepare('SELECT fail_count FROM login_lockouts WHERE login = ?').get(login);
  const count = (row?.fail_count || 0) + 1;
  const lockedUntil = count >= LOCKOUT_MAX
    ? new Date(Date.now() + LOCKOUT_MS).toISOString()
    : null;
  const newCount = count >= LOCKOUT_MAX ? 0 : count;
  db.prepare(`
    INSERT INTO login_lockouts (login, fail_count, locked_until, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(login) DO UPDATE SET
      fail_count   = excluded.fail_count,
      locked_until = excluded.locked_until,
      updated_at   = excluded.updated_at
  `).run(login, newCount, lockedUntil);
}

function clearLoginAttempts(login) {
  db.prepare('DELETE FROM login_lockouts WHERE login = ?').run(login);
}

// Clean up expired lockouts once per hour
setInterval(() => {
  db.prepare("DELETE FROM login_lockouts WHERE locked_until IS NOT NULL AND locked_until < datetime('now') AND fail_count = 0").run();
  db.prepare("DELETE FROM login_lockouts WHERE locked_until IS NULL AND updated_at < datetime('now', '-1 hour')").run();
}, 60 * 60 * 1000).unref();

const { sendMail } = require('../utils/mailer');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });
    if (typeof email !== 'string' || email.length > 254) return res.status(400).json({ error: 'Invalid email' });
    if (typeof name !== 'string' || name.length > 100) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
    if (typeof password !== 'string' || password.length > 256) return res.status(400).json({ error: 'Password too long' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const token = uuidv4().replace(/-/g, '');
    db.prepare('INSERT INTO users (id, email, password_hash, name, verified, verification_token) VALUES (?,?,?,?,?,?)').run(id, email.toLowerCase(), hash, name, 1, null);
    db.prepare('INSERT INTO subscriptions (id, user_id, plan, status) VALUES (?,?,?,?)').run(uuidv4(), id, 'free', 'active');
    logUsageEvent({
      userId: id,
      eventType: 'auth.registered',
      entityType: 'user',
      entityId: id,
      source: 'auth',
      payload: { email: email.toLowerCase() },
    });
    return res.status(201).json({ success: true, message: 'Registration successful. You can now log in.' });
  } catch (err) {
    log.error('register_failed', { message: err.message });
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// GET /api/auth/verify/:token
router.get('/verify/:token', (req, res) => {
  const { token } = req.params;
  const user = db.prepare('SELECT id FROM users WHERE verification_token = ?').get(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
  db.prepare('UPDATE users SET verified = 1, verification_token = NULL WHERE id = ?').run(user.id);
  res.json({ message: 'Email verified. You can now log in.' });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, keepSignedIn } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email/username and password required' });
    const login = normalizeLogin(email);

    // Check lockout before any DB query
    const lockMsg = checkLockout(login);
    if (lockMsg) return res.status(429).json({ error: lockMsg });

    const user = getUserByLogin(login);
    if (!user) { recordFailedLogin(login); return res.status(401).json({ error: 'Invalid credentials' }); }
    if (user.is_banned) return res.status(403).json({ error: 'Account suspended' });
    if (!user.verified) {
      db.prepare('UPDATE users SET verified = 1, verification_token = NULL WHERE id = ?').run(user.id);
      user.verified = 1;
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) { recordFailedLogin(login); return res.status(401).json({ error: 'Invalid credentials' }); }
    clearLoginAttempts(login);
    // Auto-promote SEED_ADMIN_EMAIL on login if not already admin
    if (process.env.SEED_ADMIN_EMAIL && user.email === process.env.SEED_ADMIN_EMAIL.toLowerCase() && !user.is_admin) {
      db.prepare('UPDATE users SET is_admin=1, verified=1, username=COALESCE(username, ?) WHERE id=?').run(process.env.SEED_ADMIN_USERNAME || 'admin', user.id);
      user.is_admin = 1;
    }
    // Regenerate session ID to prevent session fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        log.error('login_session_regenerate_failed', { message: err.message });
        return res.status(500).json({ error: 'Login failed. Please try again.' });
      }
      req.session.userId = user.id;
      req.session.isAdmin = !!user.is_admin;
      if (keepSignedIn) {
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
      }
      const sub = db.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
      logUsageEvent({
        userId: user.id,
        eventType: 'auth.logged_in',
        entityType: 'session',
        entityId: req.sessionID,
        source: 'auth',
        payload: { keepSignedIn: !!keepSignedIn },
      });
      return res.json({ success: true, id: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin, plan: sub?.plan || 'free' });
    });
  } catch (err) {
    log.error('login_failed', { message: err.message });
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const userId = req.session?.userId || null;
  if (userId) {
    logUsageEvent({
      userId,
      eventType: 'auth.logged_out',
      entityType: 'session',
      entityId: req.sessionID || null,
      source: 'auth',
    });
  }
  req.session.destroy((err) => {
    if (err) log.error('logout_session_destroy_failed', { message: err.message });
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, email, name, is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const sub = db.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
  const plan = sub?.plan || 'free';

  // Include usage info when running in hosted mode
  let usageInfo = null;
  if (process.env.HOSTED) {
    const { getUsageLast24h, PLAN_LIMITS } = require('../middleware/planLimits');
    const used = getUsageLast24h(user.id);
    const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
    usageInfo = { used, limit: isFinite(limit) ? limit : null, plan };
  }

  res.json({ id: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin, plan, usageInfo });
});

// GET /api/auth/status  (legacy compat)
router.get('/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.userId) });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || email.length > 254) return res.status(400).json({ error: 'Email required' });
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (user) {
    const token = uuidv4().replace(/-/g, '');
    const expiry = new Date(Date.now() + 3600000).toISOString();
    db.prepare('UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?').run(token, expiry, user.id);
    const appUrl = process.env.APP_URL || 'http://localhost:3001';
    await sendMail(email, 'Reset your password', `<p>Click <a href="${appUrl}/reset-password?token=${token}">here</a> to reset your password. Link expires in 1 hour.</p>`);
  }
  res.json({ message: 'If that email is registered you will receive a reset link.' });
});

// POST /api/auth/reset-password/:token
router.post('/reset-password/:token', async (req, res) => {
  const { token } = req.params;
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const user = db.prepare('SELECT id, reset_token_expiry FROM users WHERE reset_token = ?').get(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
  if (new Date(user.reset_token_expiry) < new Date()) return res.status(400).json({ error: 'Token expired' });
  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?').run(hash, user.id);
  res.json({ message: 'Password reset successfully. You can now log in.' });
});

// POST /api/auth/change-password (must be logged in)
router.post('/change-password', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  try {
    const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    res.json({ message: 'Password changed. Please log in again.' });
    req.session.destroy((err) => { if (err) log.error('change_password_session_destroy_failed', { message: err.message }); });
  } catch (err) {
    log.error('change_password_failed', { message: err.message });
    res.status(500).json({ error: 'Failed to change password. Please try again.' });
  }
});

// DELETE /api/auth/account (self-delete, must be logged in)
router.delete('/account', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required to delete account' });
  try {
    const user = db.prepare('SELECT id, password_hash, is_admin FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_admin) return res.status(403).json({ error: 'Admin accounts cannot be self-deleted' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.json({ message: 'Account deleted.' });
    req.session.destroy((err) => { if (err) log.error('delete_account_session_destroy_failed', { message: err.message }); });
  } catch (err) {
    log.error('delete_account_failed', { message: err.message });
    res.status(500).json({ error: 'Failed to delete account. Please try again.' });
  }
});

module.exports = router;
