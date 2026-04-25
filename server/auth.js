const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

function getJwtSecret() {
  const base = process.env.ENCRYPTION_SECRET;
  if (!base || base.length < 32) {
    throw new Error('ENCRYPTION_SECRET must be set to at least 32 characters before using JWT auth');
  }
  return crypto.createHash('sha256').update(base + ':jwt-auth-v1').digest('hex');
}

function getCredentials() {
  const hash = process.env.AUTH_PASSWORD_HASH || '';
  if (!hash) {
    console.warn('[auth] AUTH_PASSWORD_HASH not set — login will fail. Set a bcrypt hash in env vars.');
  }
  return {
    username: process.env.AUTH_USERNAME || 'admin',
    passwordHash: hash,
  };
}

async function verifyCredentials(username, password) {
  const creds = getCredentials();
  if (username !== creds.username) return false;
  if (!creds.passwordHash) return false;
  return bcrypt.compare(password, creds.passwordHash);
}

function generateToken(username, rememberMe) {
  const secret = getJwtSecret();
  const expiresIn = rememberMe ? '30d' : '24h';
  return jwt.sign({ auth: true, v: 2, sub: username }, secret, { algorithm: 'HS256', expiresIn });
}

function verifyToken(token) {
  try {
    // Explicitly allow only HS256 — rejects 'none' and algorithm-confusion attacks
    return jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

const COOKIE_NAME = 'aistudio_token';

// Static asset extensions to skip auth on
const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/;

function authMiddleware(req, res, next) {
  // Auth endpoints and health check always pass through
  if (req.path.startsWith('/api/auth/') || req.path === '/api/health') return next();
  // Static assets don't need auth checks (served by express.static)
  if (STATIC_EXTENSIONS.test(req.path)) return next();

  const token = req.cookies?.[COOKIE_NAME];
  if (!token || !verifyToken(token)) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    // Non-API routes: serve index.html (React handles /login redirect)
    return next();
  }
  // Basic CSRF check: non-GET API requests must have JSON content-type, multipart, or be DELETE/PATCH
  // DELETE and PATCH are safe — HTML forms can only submit GET/POST
  if (req.path.startsWith('/api/') && req.method === 'POST') {
    const ct = req.headers['content-type'] || '';
    const xhr = req.headers['x-requested-with'];
    if (!ct.includes('application/json') && !ct.includes('multipart/form-data') && !xhr) {
      return res.status(403).json({ success: false, error: 'CSRF check failed' });
    }
  }
  next();
}

module.exports = { verifyCredentials, generateToken, verifyToken, authMiddleware, COOKIE_NAME };
