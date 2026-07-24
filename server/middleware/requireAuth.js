'use strict';
const db = require('../db');
const { enterWithUser } = require('../userContext');

function requireAuth(req, res, next) {
  if (req.path.startsWith('/api/auth/') || req.path === '/api/health' || req.path === '/api/bootstrap-admin' || req.path === '/api/app-usage' || req.path === '/api/app-license/activate') return next();
  if (req.session && req.session.userId) {
    // Keep the user context available across Express route hops and upload stream callbacks.
    req.userId = req.session.userId;
    enterWithUser(req.session.userId);
    return next();
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
      req.userId = req.session.userId;
      enterWithUser(req.session.userId);
      return next();
    }

    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
    if (user?.is_admin) {
      req.session.isAdmin = true;
      req.userId = req.session.userId;
      enterWithUser(req.session.userId);
      return next();
    }
  }
  return res.status(403).json({ error: 'Forbidden' });
}

function requireOwner(req, res, next) {
  if (req.session && req.session.userId) {
    if (req.session.isOwner) {
      req.userId = req.session.userId;
      enterWithUser(req.session.userId);
      return next();
    }
    const user = db.prepare('SELECT is_owner FROM users WHERE id = ?').get(req.session.userId);
    if (user?.is_owner) {
      req.session.isOwner = true;
      req.userId = req.session.userId;
      enterWithUser(req.session.userId);
      return next();
    }
  }
  return res.status(403).json({ error: 'Forbidden — owner only' });
}

module.exports = { requireAuth, requireAdmin, requireOwner };
