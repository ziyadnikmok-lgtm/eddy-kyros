const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyCredentials, generateToken, verifyToken, COOKIE_NAME } = require('../auth');

const router = express.Router();

// Fix #17: Rate limit login to prevent brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts — try again in 15 minutes' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, rememberMe } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }
  const valid = await verifyCredentials(username, password);
  if (!valid) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
  const token = generateToken(username, !!rememberMe);
  const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : undefined; // 30 days or session
  const isSecure = process.env.NODE_ENV === 'production' || req.protocol === 'https';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    ...(maxAge ? { maxAge } : {}),
  });
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  const isSecure = process.env.NODE_ENV === 'production' || req.protocol === 'https';
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isSecure, sameSite: 'lax' });
  res.json({ success: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ success: false, authenticated: false });
  }
  res.json({ success: true, authenticated: true, username: process.env.AUTH_USERNAME || 'admin' });
});

module.exports = router;
