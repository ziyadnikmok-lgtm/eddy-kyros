'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const db = require('../db');

const router = express.Router();

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendMail(to, subject, html) {
  try {
    const t = getTransport();
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html });
  } catch (e) {
    console.error('[MAIL] Failed to send email:', e.message);
  }
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  const token = uuidv4().replace(/-/g, '');
  // Auto-verify (no email server required); send email if SMTP is configured
  const hasSmtp = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
  const verified = hasSmtp ? 0 : 1;
  db.prepare('INSERT INTO users (id, email, password_hash, name, verified, verification_token) VALUES (?,?,?,?,?,?)').run(id, email.toLowerCase(), hash, name, verified, token);
  db.prepare('INSERT INTO subscriptions (id, user_id, plan, status) VALUES (?,?,?,?)').run(uuidv4(), id, 'free', 'active');
  if (hasSmtp) {
    const appUrl = process.env.APP_URL || 'http://localhost:3001';
    await sendMail(email, 'Verify your AI Content Studio account', `<p>Click <a href="${appUrl}/verify-email?token=${token}">here</a> to verify your email.</p>`);
    return res.status(201).json({ message: 'Registration successful. Check your email to verify.' });
  }
  res.status(201).json({ message: 'Registration successful. You can now log in.' });
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
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.is_banned) return res.status(403).json({ error: 'Account suspended' });
  if (!user.verified) return res.status(403).json({ error: 'Please verify your email first' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.userId = user.id;
  req.session.isAdmin = !!user.is_admin;
  const sub = db.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
  res.json({ success: true, id: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin, plan: sub?.plan || 'free' });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out' }));
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id, email, name, is_admin FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const sub = db.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
  res.json({ id: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin, plan: sub?.plan || 'free' });
});

// GET /api/auth/status  (legacy compat)
router.get('/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.userId) });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
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

module.exports = router;
