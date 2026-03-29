'use strict';
const { runWithUser } = require('../userContext');

function requireAuth(req, res, next) {
  if (req.path.startsWith('/api/auth/') || req.path === '/api/health') return next();
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
  if (req.session && req.session.userId && req.session.isAdmin) {
    return runWithUser(req.session.userId, () => next());
  }
  return res.status(403).json({ error: 'Forbidden' });
}

module.exports = { requireAuth, requireAdmin };
