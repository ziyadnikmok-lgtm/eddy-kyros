'use strict';
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

// GET /api/admin/users
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.is_admin, u.is_banned, u.verified, u.created_at,
           s.plan, s.status, s.expires_at
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
      AND s.created_at = (SELECT MAX(s2.created_at) FROM subscriptions s2 WHERE s2.user_id = u.id)
    ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// PATCH /api/admin/users/:id
router.patch('/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { plan, is_banned, is_admin } = req.body || {};
  if (plan !== undefined) {
    const { v4: uuidv4 } = require('uuid');
    db.prepare('INSERT INTO subscriptions (id, user_id, plan, status) VALUES (?,?,?,?)').run(uuidv4(), id, plan, 'active');
  }
  if (is_banned !== undefined) db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(is_banned ? 1 : 0, id);
  if (is_admin !== undefined) db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, id);
  res.json({ message: 'Updated' });
});

module.exports = router;
