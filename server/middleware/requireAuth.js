'use strict';

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.isAdmin) {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden' });
}

module.exports = { requireAuth, requireAdmin };
