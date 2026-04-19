'use strict';
const db = require('../db');
const { runWithUser } = require('../userContext');

function requireAuth(req, res, next) {
  if (req.path.startsWith('/api/auth/') || req.path === '/api/health' || req.path === '/api/bootstrap-admin') return next();
  if (req.session && req.session.userId) {
    // Thread the userId through AsyncLocalStorage so all services can read it
    return runWithUser(req.session.userId, () => next());
  }
  // Static assets pass through without auth
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/.test(req.path)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next(); // React handles redirect for non-API routes
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.userId) {
    if (req.session.isAdmin) {
      return runWithUser(req.session.userId, () => next());
    }

    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
    if (user?.is_admin) {
      req.session.isAdmin = true;
      return runWithUser(req.session.userId, () => next());
    }
  }
  return res.status(403).json({ error: 'Forbidden' });
}

function requireOwner(req, res, next) {
  if (req.session && req.session.userId) {
    if (req.session.isOwner) {
      return runWithUser(req.session.userId, () => next());
    }
    const user = db.prepare('SELECT is_owner FROM users WHERE id = ?').get(req.session.userId);
    if (user?.is_owner) {
      req.session.isOwner = true;
      return runWithUser(req.session.userId, () => next());
    }
  }
  return res.status(403).json({ error: 'Forbidden — owner only' });
}

module.exports = { requireAuth, requireAdmin, requireOwner };
