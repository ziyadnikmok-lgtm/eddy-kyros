const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

function getJwtSecret() {
  const base = process.env.ENCRYPTION_SECRET || 'fallback-insecure-secret-change-me';
  return crypto.createHash('sha256').update(base + ':jwt-auth-v1').digest('hex');
}

function getCredentials() {
  return {
    username: process.env.AUTH_USERNAME || 'admin',
    passwordHash: process.env.AUTH_PASSWORD_HASH || '',
    passwordPlain: process.env.AUTH_PASSWORD || '',
  };
}

async function verifyCredentials(username, password) {
  const creds = getCredentials();
  if (username !== creds.username) return false;
  if (creds.passwordHash) {
    return bcrypt.compare(password, creds.passwordHash);
  }
  if (creds.passwordPlain) {
    return password === creds.passwordPlain;
  }
  return false;
}

function generateToken(rememberMe) {
  const secret = getJwtSecret();
  const expiresIn = rememberMe ? '30d' : '24h';
  return jwt.sign({ auth: true, v: 1 }, secret, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

const COOKIE_NAME = 'aistudio_token';

function authMiddleware(req, res, next) {
  // Auth endpoints always pass through
  if (req.path.startsWith('/api/auth/')) return next();

  const token = req.cookies?.[COOKIE_NAME];
  if (!token || !verifyToken(token)) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    // Non-API routes: serve index.html (React handles /login redirect)
    return next();
  }
  next();
}

module.exports = { verifyCredentials, generateToken, verifyToken, authMiddleware, COOKIE_NAME };
